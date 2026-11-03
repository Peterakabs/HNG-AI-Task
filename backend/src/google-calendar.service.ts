import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SupabaseService } from './supabase.service';

type GoogleEvent = { id: string; title: string; start: string; end: string; allDay: boolean; htmlLink?: string; description?: string };

@Injectable()
export class GoogleCalendarService {
  constructor(private readonly supabase: SupabaseService) {}

  async connect(userId: string, input: Record<string, unknown>) {
    const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken.trim() : '';
    if (!refreshToken || refreshToken.length > 4096) throw new BadRequestException('Google did not return calendar access. Reconnect and approve calendar access.');
    const email = typeof input.email === 'string' && input.email.includes('@') ? input.email.slice(0, 320) : null;
    const encrypted = this.encrypt(refreshToken);
    const { error } = await this.supabase.db.from('google_calendar_connections').upsert({ user_id: userId, google_email: email, encrypted_refresh_token: encrypted, updated_at: new Date().toISOString() });
    if (error) throw new ServiceUnavailableException(`Could not save Google Calendar connection: ${error.message}`);
    return { connected: true, email };
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
