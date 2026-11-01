import { BadRequestException, Injectable, Logger, NestMiddleware, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SupabaseStore, ScopeContext } from './store';
import { SupabaseService } from './supabase.service';

type SessionCookie = { access_token: string; refresh_token: string };
type GuestAccount = { id: string; device_id: string; created_at: string };
export type RequestIdentity = { type: 'user'; id: string; email?: string } | { type: 'guest'; deviceId: string; guestUserId?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(private readonly supabase: SupabaseService, private readonly store: SupabaseStore) {}

  async identityFromCookie(cookieHeader: string | undefined) {
    const raw = this.readCookie(cookieHeader, 'spectre_session');
    if (!raw) return undefined;
    let bundle: SessionCookie;
    try { bundle = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8')); }
    catch { throw new UnauthorizedException('Invalid session. Please log in again.'); }
    if (!bundle.access_token || !bundle.refresh_token) throw new UnauthorizedException('Invalid session. Please log in again.');
    let { data, error } = await this.supabase.auth.getUser(bundle.access_token);
    let refreshed: SessionCookie | undefined;
    if (error) {
      const result = await this.supabase.newClient().auth.refreshSession({ refresh_token: bundle.refresh_token });
      if (result.error || !result.data.session) throw new UnauthorizedException('Your session expired. Please log in again.');
      data = { user: result.data.user! }; error = null;
      refreshed = { access_token: result.data.session.access_token, refresh_token: result.data.session.refresh_token };
    }
    if (!data.user) throw new UnauthorizedException('This account session is no longer valid. Please log in again.');
    return { identity: { type: 'user' as const, id: data.user.id, email: data.user.email }, session: refreshed && this.encodeSession(refreshed) };
  }

  createGuestIdentity(value: unknown): Extract<RequestIdentity, { type: 'guest' }> {
    if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException('A valid installation ID is required.');
    return { type: 'guest', deviceId: value.toLowerCase() };
  }

  guestCookieId(cookieHeader: string | undefined) { return this.readCookie(cookieHeader, 'guest_user_id'); }

  async getGuestAccount(id: string): Promise<GuestAccount | undefined> {
    if (!UUID.test(id)) return undefined;
    const { data, error } = await this.supabase.db.from('guest_accounts').select('id,device_id,created_at').eq('id', id).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load guest account: ${error.message}`);
    return data || undefined;
  }

  async ensureGuestAccount(deviceId: string) {
    const canonical = this.createGuestIdentity(deviceId).deviceId;
    const { data: existing, error: lookupError } = await this.supabase.db.from('guest_accounts').select('id').eq('device_id', canonical).maybeSingle();
    if (lookupError) throw new ServiceUnavailableException(`Could not look up guest account: ${lookupError.message}`);
    if (existing) return { guestUserId: existing.id as string, created: false };
    const { data, error } = await this.supabase.db.from('guest_accounts').insert({ id: randomUUID(), device_id: canonical }).select('id').single();
    if (error?.code === '23505') {
      const { data: concurrent, error: retryError } = await this.supabase.db.from('guest_accounts').select('id').eq('device_id', canonical).single();
      if (retryError) throw new ServiceUnavailableException(`Could not reuse guest account: ${retryError.message}`);
      return { guestUserId: concurrent.id as string, created: false };
    }
    if (error) throw new ServiceUnavailableException(`Could not create guest account: ${error.message}`);
    this.logger.log(`Created guest account ${data.id} for device ${canonical.slice(0, 8)}.`);
    return { guestUserId: data.id as string, created: true };
  }

  async register(input: Record<string, any>) {
    const email = this.cleanEmail(input.email); const password = this.cleanPassword(input.password);
    const { data, error } = await this.supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) throw new BadRequestException('An account with this email already exists.');
      throw new ServiceUnavailableException(`Could not create account: ${error.message}`);
    }
    const signedIn = await this.supabase.newClient().auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session || !data.user) throw new ServiceUnavailableException('Account created, but sign-in could not be started. Please log in.');
    return { user: this.publicUser(data.user), session: this.encodeSession(signedIn.data.session) };
  }

  async login(input: Record<string, any>) {
    const email = this.cleanEmail(input.email); const password = this.cleanPassword(input.password, false);
    const { data, error } = await this.supabase.newClient().auth.signInWithPassword({ email, password });
    if (error || !data.user || !data.session) throw new UnauthorizedException('Email or password is incorrect.');
    return { user: this.publicUser(data.user), session: this.encodeSession(data.session) };
  }

  async logout(cookieHeader?: string) {
    const raw = this.readCookie(cookieHeader, 'spectre_session');
    if (!raw) return;
    try {
      const session = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8')) as SessionCookie;
      if (session.access_token) await this.supabase.auth.admin.signOut(session.access_token, 'local');
    } catch (error) { this.logger.warn(`Session revoke failed during logout: ${error instanceof Error ? error.message : 'unknown error'}`); }
  }

  async getUser(id: string) {
    const { data, error } = await this.supabase.auth.admin.getUserById(id);
    if (error) return null;
    return this.publicUser(data.user);
  }

  async transferGuestData(userId: string, guestUserId: string, confirmed: boolean) {
    if (!confirmed) throw new BadRequestException('Confirm the guest data transfer before continuing.');
    if (!(await this.getUser(userId))) throw new UnauthorizedException('Authenticated account not found.');
    const guest = await this.getGuestAccount(guestUserId);
    if (!guest) throw new BadRequestException('The guest account is no longer available.');
    const source = await this.store.read(`guest:${guest.device_id}`);
    const destination = await this.store.read(`user:${userId}`);
    const taskFingerprint = (task: Record<string, any>) => `${String(task.title || '').trim().toLowerCase()}\u0000${task.start || ''}\u0000${task.due || ''}`;
    const knownTaskIds = new Set(destination.tasks.map((task) => task.id).filter(Boolean));
    const knownTasks = new Set(destination.tasks.map(taskFingerprint));
    const tasks = source.tasks.filter((task) => {
      const fingerprint = taskFingerprint(task);
      if ((task.id && knownTaskIds.has(task.id)) || knownTasks.has(fingerprint)) return false;
      if (task.id) knownTaskIds.add(task.id); knownTasks.add(fingerprint); return true;
    });
    const noteFingerprint = (note: Record<string, any>) => `${String(note.title || '').trim().toLowerCase()}\u0000${String(note.text || '').trim()}`;
    const knownNoteIds = new Set(destination.notes.map((note) => note.id).filter(Boolean));
    const knownNotes = new Set(destination.notes.map(noteFingerprint));
    const notes = source.notes.filter((note) => {
      const fingerprint = noteFingerprint(note);
      if ((note.id && knownNoteIds.has(note.id)) || knownNotes.has(fingerprint)) return false;
      if (note.id) knownNoteIds.add(note.id); knownNotes.add(fingerprint); return true;
    });
    const foldersMerged = source.folders.filter((item) => !destination.folders.includes(item)).length;
    const tagsMerged = source.tags.filter((item) => !destination.tags.includes(item)).length;
    destination.tasks = [...destination.tasks, ...tasks]; destination.notes = [...destination.notes, ...notes];
    destination.folders = [...new Set([...destination.folders, ...source.folders])];
    destination.tags = [...new Set([...destination.tags, ...source.tags])];
    await this.store.write(destination, `user:${userId}`);
    return { tasksTransferred: tasks.length, notesTransferred: notes.length, foldersMerged, tagsMerged };
  }

  async requestPasswordReset(value: unknown) {
    const email = this.cleanEmail(value);
    const redirectTo = `${(process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')}/?type=recovery`;
    const { error } = await this.supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new ServiceUnavailableException(`Could not send password reset email: ${error.message}`);
    return { message: 'If an account exists for that email, a password reset link has been sent.' };
  }

  async resetPassword(tokenValue: unknown, passwordValue: unknown) {
    if (typeof tokenValue !== 'string' || tokenValue.length > 4096) throw new BadRequestException('This password reset link is invalid or expired. Request a new one.');
    const password = this.cleanPassword(passwordValue);
    const { data, error } = await this.supabase.auth.getUser(tokenValue);
    if (error || !data.user) throw new BadRequestException('This password reset link is invalid or expired. Request a new one.');
    const update = await this.supabase.auth.admin.updateUserById(data.user.id, { password });
    if (update.error) throw new ServiceUnavailableException(`Could not update password: ${update.error.message}`);
    return { message: 'Password updated. You can now log in with your new password.' };
  }

  async createAction(userId: string, input: Record<string, any>) {
    if (input.confirmed !== true) throw new BadRequestException('Confirm the reminder before scheduling it.');
    const recipientName = this.required(input.recipientName, 'Recipient name');
    const recipientEmail = this.cleanEmail(input.recipientEmail);
    const subject = this.required(input.subject, 'Subject'); const message = this.required(input.message, 'Message');
    const scheduledAt = typeof input.scheduledAt === 'string' ? Date.parse(input.scheduledAt) : NaN;
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) throw new BadRequestException('Reminder time must be in the future.');
    const timezone = this.required(input.timezone, 'Timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new BadRequestException('A valid timezone is required.'); }
    const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId.slice(0, 100) : null;
    if (clientRequestId) {
      const { data: prior, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('creator_user_id', userId).eq('client_request_id', clientRequestId).maybeSingle();
      if (error) throw new ServiceUnavailableException(`Could not check reminder: ${error.message}`);
      if (prior) return this.actionFromRow(prior);
    }
    const { data, error } = await this.supabase.db.from('scheduled_actions').insert({ creator_user_id: userId, client_request_id: clientRequestId, recipient_name: recipientName, recipient_email: recipientEmail, subject, message, scheduled_at: new Date(scheduledAt).toISOString(), timezone, status: 'scheduled' }).select('*').single();
    if (error) {
      if (error.code === '23505' && clientRequestId) return this.getActionByRequestId(userId, clientRequestId);
      throw new ServiceUnavailableException(`Could not schedule reminder: ${error.message}`);
    }
    return this.actionFromRow(data);
  }

  async listActions(userId: string) {
    const { data, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('creator_user_id', userId).order('scheduled_at', { ascending: true });
    if (error) throw new ServiceUnavailableException(`Could not load reminders: ${error.message}`);
    return data.map((row) => this.actionFromRow(row));
  }
  async getAction(userId: string, id: string) {
    const { data, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('id', id).eq('creator_user_id', userId).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load reminder: ${error.message}`);
    if (!data) throw new UnauthorizedException('Scheduled action not found.');
    return this.actionFromRow(data);
  }
  async claimDueActions() {
    const { data, error } = await this.supabase.db.rpc('claim_due_scheduled_actions', { p_limit: 50 });
    if (error) throw new ServiceUnavailableException(`Could not claim reminders: ${error.message}`);
    return (data || []).map((row: any) => this.actionFromRow(row));
  }
  async finishAction(id: string, errorMessage?: string) {
    const { error } = await this.supabase.db.from('scheduled_actions').update({ status: errorMessage ? 'failed' : 'completed', failure_reason: errorMessage || null, completed_at: new Date().toISOString() }).eq('id', id).eq('status', 'sending');
    if (error) this.logger.error(`Could not finish scheduled action ${id}: ${error.message}`);
  }

  async sendEmail(to: string, subject: string, text: string) {
    const key = process.env.SENDGRID_API_KEY; const from = process.env.EMAIL_FROM;
    if (!key || !from) throw new Error('Email delivery is not configured. Set SENDGRID_API_KEY and EMAIL_FROM.');
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject, content: [{ type: 'text/plain', value: text }] }) });
    if (!response.ok) throw new Error(`Email provider rejected the message (${response.status}).`);
  }

  encodeSession(session: { access_token: string; refresh_token: string }) { return Buffer.from(JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token })).toString('base64url'); }
  private async getActionByRequestId(userId: string, clientRequestId: string) {
    const { data, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('creator_user_id', userId).eq('client_request_id', clientRequestId).single();
    if (error) throw new ServiceUnavailableException(`Could not retrieve reminder: ${error.message}`);
    return this.actionFromRow(data);
  }
  private actionFromRow(row: any) { return { id: row.id, clientRequestId: row.client_request_id, creatorUserId: row.creator_user_id, recipientName: row.recipient_name, recipientEmail: row.recipient_email, recipientUserId: null, subject: row.subject, message: row.message, scheduledAt: Date.parse(row.scheduled_at), timezone: row.timezone, status: row.status, createdAt: Date.parse(row.created_at), failureReason: row.failure_reason, attemptedAt: row.attempted_at ? Date.parse(row.attempted_at) : undefined, completedAt: row.completed_at ? Date.parse(row.completed_at) : undefined }; }
  private publicUser(user: { id: string; email?: string; created_at?: string; updated_at?: string }) { return { id: user.id, email: user.email, createdAt: user.created_at ? Date.parse(user.created_at) : Date.now(), updatedAt: user.updated_at ? Date.parse(user.updated_at) : Date.now() }; }
  private cleanEmail(value: unknown) { if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new BadRequestException('A valid email address is required.'); return value.trim().toLowerCase(); }
  private cleanPassword(value: unknown, enforce = true) { if (typeof value !== 'string' || (enforce && value.length < 8) || value.length > 256) throw new BadRequestException(enforce ? 'Password must be between 8 and 256 characters.' : 'Password is required.'); return value; }
  private required(value: unknown, label: string) { if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new BadRequestException(`${label} is required.`); return value.trim(); }
  private readCookie(header: string | undefined, name: string) {
    const value = header?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
    if (value === undefined) return undefined;
    try { return decodeURIComponent(value); } catch { return ''; }
  }
}

@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService, private readonly scopes: ScopeContext) {}
  use(request: Request & { identity?: RequestIdentity }, response: Response, next: NextFunction) {
    void (async () => {
      if (request.path === '/api/health' || request.path === '/api/health/supabase') return next();
      try {
        const session = await this.auth.identityFromCookie(request.headers.cookie);
        let identity: RequestIdentity | undefined = session?.identity;
        if (session?.session) response.cookie('spectre_session', session.session, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 });
        if (!identity) {
          const guestCookieId = this.auth.guestCookieId(request.headers.cookie);
          const guestAccount = guestCookieId ? await this.auth.getGuestAccount(guestCookieId) : undefined;
          if (guestAccount) identity = { type: 'guest', deviceId: guestAccount.device_id, guestUserId: guestAccount.id };
          else {
            if (guestCookieId !== undefined) response.clearCookie('guest_user_id', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
            const deviceId = request.headers['x-device-id'];
            if (deviceId !== undefined) identity = this.auth.createGuestIdentity(deviceId);
            else if (request.path === '/api/auth/guest') identity = this.auth.createGuestIdentity(randomUUID());
            else if (request.path === '/api/auth/me') return next();
            else throw new BadRequestException('A guest account cookie is required.');
          }
        }
        request.identity = identity;
        const scope = identity.type === 'user' ? `user:${identity.id}` : `guest:${identity.deviceId}`;
        this.scopes.run(scope, next);
      } catch (error) { next(error); }
    })();
  }
}
