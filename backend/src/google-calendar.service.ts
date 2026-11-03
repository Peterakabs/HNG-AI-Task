import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SupabaseService } from './supabase.service';

type GoogleEvent = { id: string; title: string; start: string; end: string; allDay: boolean; htmlLink?: string; description?: string };

@Injectable()
export class GoogleCalendarService {
  constructor(private readonly supabase: SupabaseService) {}

  beginOAuth(userId: string) {
    const { clientId, redirectUri } = this.oauthConfig();
    const nonce = randomBytes(32).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId, nonce, expiresAt: Date.now() + 10 * 60_000 })).toString('base64url');
    const signature = this.signState(payload);
    const state = `${payload}.${signature}`;
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.events.readonly',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return { nonce, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
  }

  async completeOAuth(userId: string, code: string, state: string, stateCookie: string) {
    if (!code || code.length > 4096) throw new BadRequestException('Google authorization did not return a valid code.');
    this.validateState(userId, state, stateCookie);
    const { clientId, clientSecret, redirectUri } = this.oauthConfig();
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    });
    const tokens = await tokenResponse.json().catch(() => ({})) as Record<string, any>;
    if (!tokenResponse.ok || typeof tokens.access_token !== 'string') throw new UnauthorizedException('Google could not complete Calendar authorization. Reconnect and approve the requested access.');
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new UnauthorizedException('Google did not return offline Calendar access. Reconnect and approve the Calendar permission.');

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const profile = await profileResponse.json().catch(() => ({})) as Record<string, any>;
    if (!profileResponse.ok || typeof profile.email !== 'string' || profile.email_verified !== true) throw new UnauthorizedException('Google did not return a verified account email. Please reconnect Google Calendar.');
    return this.saveConnection(userId, tokens.refresh_token, profile.email);
  }

  callbackUrl(result: 'connected' | 'error', reason?: string) {
    const base = process.env.WEB_ORIGIN?.trim() || process.env.APP_URL?.trim() || 'http://localhost:5173';
    const destination = new URL('/', base);
    destination.searchParams.set('googleCalendar', result);
    if (reason) destination.searchParams.set('reason', reason);
    return destination.toString();
  }

  async disconnect(userId: string) {
    const { error } = await this.supabase.db.from('google_calendar_connections').delete().eq('user_id', userId);
    if (error) throw new ServiceUnavailableException(`Could not disconnect Google Calendar: ${error.message}`);
    return { connected: false };
  }

  async events(userId: string, timeMin: string, timeMax: string) {
    const min = Date.parse(timeMin); const max = Date.parse(timeMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || max - min > 93 * 24 * 60 * 60 * 1000) throw new BadRequestException('Choose a valid calendar range of up to 93 days.');
    const connection = await this.connection(userId);
    if (!connection) return { connected: false, email: null, events: [] as GoogleEvent[] };
    const accessToken = await this.googleAccessToken(this.decrypt(connection.encrypted_refresh_token));
    const query = new URLSearchParams({ timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new UnauthorizedException('Google Calendar access expired or was revoked. Reconnect Google Calendar from your profile.');
      throw new ServiceUnavailableException(payload?.error?.message || 'Could not load Google Calendar events.');
    }
    const events: GoogleEvent[] = (payload.items || []).filter((item: any) => item.status !== 'cancelled').map((item: any) => ({
      id: String(item.id), title: String(item.summary || 'Untitled event'), start: String(item.start?.dateTime || item.start?.date || ''), end: String(item.end?.dateTime || item.end?.date || ''), allDay: !item.start?.dateTime, htmlLink: typeof item.htmlLink === 'string' ? item.htmlLink : undefined, description: typeof item.description === 'string' ? item.description.slice(0, 1000) : undefined,
    })).filter((event: GoogleEvent) => event.start && event.end);
    return { connected: true, email: connection.google_email, events };
  }

  async conflicts(userId: string, dueValue: string, localDate?: string) {
    const due = Date.parse(dueValue);
    if (!Number.isFinite(due)) throw new BadRequestException('A valid task due time is required.');
    const from = new Date(due - 30 * 60_000).toISOString(); const to = new Date(due + 30 * 60_000).toISOString();
    const result = await this.events(userId, from, to);
    const dueEvent = result.events.filter((event) => {
      const start = Date.parse(event.start); const end = Date.parse(event.end);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(localDate || '') ? localDate! : new Date(due).toISOString().slice(0, 10);
      return event.allDay ? day >= event.start && day < event.end : start < Date.parse(to) && end > Date.parse(from);
    });
    return { connected: result.connected, events: dueEvent };
  }

  async status(userId: string) {
    const connection = await this.connection(userId);
    return { connected: Boolean(connection), email: connection?.google_email || null };
  }

  private async connection(userId: string) {
    const { data, error } = await this.supabase.db.from('google_calendar_connections').select('google_email,encrypted_refresh_token').eq('user_id', userId).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load Google Calendar connection: ${error.message}`);
    return data as { google_email: string | null; encrypted_refresh_token: string } | null;
  }

  private async saveConnection(userId: string, refreshToken: string, email: string | null) {
    const encrypted = this.encrypt(refreshToken);
    const { error } = await this.supabase.db.from('google_calendar_connections').upsert({ user_id: userId, google_email: email, encrypted_refresh_token: encrypted, updated_at: new Date().toISOString() });
    if (error) throw new ServiceUnavailableException(`Could not save Google Calendar connection: ${error.message}`);
    return { connected: true, email };
  }

  private oauthConfig() {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || '';
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '';
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || '';
    if (!clientId || !clientSecret || !redirectUri) throw new ServiceUnavailableException('Google Calendar OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI on the backend.');
    let parsed: URL;
    try { parsed = new URL(redirectUri); } catch { throw new ServiceUnavailableException('GOOGLE_OAUTH_REDIRECT_URI must be an absolute HTTPS URL.'); }
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production.');
    return { clientId, clientSecret, redirectUri };
  }

  private signState(payload: string) {
    return createHmac('sha256', this.encryptionKey()).update(`google-calendar-oauth:${payload}`).digest('base64url');
  }
  private validateState(userId: string, state: string, cookieNonce: string) {
    const [payload, signature, extra] = String(state || '').split('.');
    if (!payload || !signature || extra || !cookieNonce || cookieNonce.length > 128) throw new UnauthorizedException('Google Calendar authorization expired. Please try again.');
    const expected = Buffer.from(this.signState(payload)); const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new UnauthorizedException('Google Calendar authorization could not be verified. Please try again.');
    let claims: { userId?: string; nonce?: string; expiresAt?: number };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new UnauthorizedException('Google Calendar authorization could not be verified. Please try again.'); }
    if (claims.userId !== userId || claims.nonce !== cookieNonce || !Number.isFinite(claims.expiresAt) || claims.expiresAt! <= Date.now()) throw new UnauthorizedException('Google Calendar authorization expired or belongs to another account. Please try again.');
  }

  private async googleAccessToken(refreshToken: string) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(); const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new ServiceUnavailableException('Google Calendar is not configured on the backend. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
    const result = await response.json().catch(() => ({})) as any;
    if (!response.ok || typeof result.access_token !== 'string') throw new UnauthorizedException('Could not refresh Google Calendar access. Reconnect Google Calendar from your profile.');
    return result.access_token as string;
  }

  private encryptionKey() {
    const value = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim() || '';
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new ServiceUnavailableException('Google Calendar token encryption is not configured. Set GOOGLE_TOKEN_ENCRYPTION_KEY to a random 32-byte hex value.');
    return Buffer.from(value, 'hex');
  }
  private encrypt(value: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }
  private decrypt(value: string) {
    try { const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url')); const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'); }
    catch (error) { if (error instanceof ServiceUnavailableException) throw error; throw new ServiceUnavailableException('The saved Google Calendar connection could not be decrypted. Reconnect Google Calendar.'); }
  }
}
