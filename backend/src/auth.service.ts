import { BadRequestException, HttpException, Injectable, Logger, NestMiddleware, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  private readonly guestRequestWindows = new Map<string, { startedAt: number; count: number }>();
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
    const taskIdMap: Record<string, string> = {};
    const tasks: Record<string, any>[] = [];
    for (const task of source.tasks) {
      const sameId = destination.tasks.find((item) => item.id && item.id === task.id);
      const sameTask = sameId || destination.tasks.find((item) => taskFingerprint(item) === taskFingerprint(task));
      if (sameTask) { if (task.id && sameTask.id) taskIdMap[task.id] = sameTask.id; continue; }
      tasks.push(task);
      if (task.id) taskIdMap[task.id] = task.id;
    }
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
    return { tasksTransferred: tasks.length, notesTransferred: notes.length, foldersMerged, tagsMerged, taskIdMap };
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
    const missingEmailConfig = this.missingEmailConfiguration();
    if (missingEmailConfig.length) throw new ServiceUnavailableException(`Email reminders are not configured. Set ${missingEmailConfig.join(' and ')} in the backend environment.`);
    const recipientName = this.required(input.recipientName, 'Recipient name');
    const recipientEmail = this.cleanEmail(input.recipientEmail);
    const subject = this.required(input.subject, 'Subject'); const message = this.required(input.message, 'Message');
    const scheduledAt = typeof input.scheduledAt === 'string' ? Date.parse(input.scheduledAt) : NaN;
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) throw new BadRequestException('Reminder time must be in the future.');
    const timezone = this.required(input.timezone, 'Timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new BadRequestException('A valid timezone is required.'); }
    const taskId = typeof input.taskId === 'string' && input.taskId.trim() ? input.taskId.trim().slice(0, 100) : null;
    if (taskId) {
      const ownerData = await this.store.read(`user:${userId}`);
      if (!ownerData.tasks.some((task) => task.id === taskId)) throw new BadRequestException('The linked task is not in this account. Transfer the guest task or remove its reminder link before scheduling.');
    }
    const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId.slice(0, 100) : null;
    if (clientRequestId) {
      const { data: prior, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('creator_user_id', userId).eq('client_request_id', clientRequestId).maybeSingle();
      if (error) throw new ServiceUnavailableException(`Could not check reminder: ${error.message}`);
      if (prior) {
        if (taskId) await this.setLinkedTaskPending(userId, taskId);
        return this.actionFromRow(prior);
      }
    }
    const { data, error } = await this.supabase.db.from('scheduled_actions').insert({ creator_user_id: userId, client_request_id: clientRequestId, task_id: taskId, recipient_name: recipientName, recipient_email: recipientEmail, subject, message, scheduled_at: new Date(scheduledAt).toISOString(), timezone, status: 'scheduled', attempt_count: 0 }).select('*').single();
    if (error) {
      if (error.code === '23505' && clientRequestId) {
        if (taskId) await this.setLinkedTaskPending(userId, taskId);
        return this.getActionByRequestId(userId, clientRequestId);
      }
      throw new ServiceUnavailableException(`Could not schedule reminder: ${error.message}`);
    }
    if (taskId) await this.setLinkedTaskPending(userId, taskId);
    return this.actionFromRow(data);
  }

  async listActions(userId: string) {
    const { data, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('creator_user_id', userId).order('scheduled_at', { ascending: true });
    if (error) throw new ServiceUnavailableException(`Could not load reminders: ${error.message}`);
    const ownerData = await this.store.read(`user:${userId}`);
    return data.map((row) => ({ ...this.actionFromRow(row), taskStatus: ownerData.tasks.find((task) => task.id === row.task_id)?.status || null }));
  }
  async getAction(userId: string, id: string) {
    const { data, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('id', id).eq('creator_user_id', userId).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load reminder: ${error.message}`);
    if (!data) throw new UnauthorizedException('Scheduled action not found.');
    const ownerData = await this.store.read(`user:${userId}`);
    return { ...this.actionFromRow(data), taskStatus: ownerData.tasks.find((task) => task.id === data.task_id)?.status || null };
  }
  async claimDueActions() {
    const { data, error } = await this.supabase.db.rpc('claim_due_scheduled_actions', { p_limit: 50 });
    if (error) throw new ServiceUnavailableException(`Could not claim reminders: ${error.message}`);
    return (data || []).map((row: any) => this.actionFromRow(row));
  }
  async finishAction(id: string, errorMessage?: string) {
    if (!errorMessage) {
      const { error } = await this.supabase.db.rpc('finish_scheduled_action_sent', { p_action_id: id });
      if (error) this.logger.error(`Could not finish scheduled action ${id}: ${error.message}`);
      return;
    }
    const { data, error } = await this.supabase.db.rpc('fail_scheduled_action', { p_action_id: id, p_failure_reason: errorMessage, p_max_attempts: 5 });
    if (error) this.logger.error(`Could not record failure for scheduled action ${id}: ${error.message}`);
    else if (data === 'failed') this.logger.error(`Scheduled action ${id} failed after all retry attempts: ${errorMessage}`);
  }

  async createGuestReminderLink(actionId: string, scheduledAt: number) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Math.max(Date.now() + 30 * 86400_000, scheduledAt + 90 * 86400_000)).toISOString();
    const { error } = await this.supabase.db.from('guest_reminder_tokens').insert({ scheduled_action_id: actionId, token_hash: tokenHash, expires_at: expiresAt });
    if (error) throw new ServiceUnavailableException(`Could not prepare guest reminder access: ${error.message}`);
    const appUrl = (process.env.APP_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')).trim().replace(/\/$/, '');
    if (!appUrl) throw new ServiceUnavailableException('Reminder links are not configured. Set APP_URL in the backend environment.');
    return `${appUrl}/#reminder=${token}`;
  }

  async getGuestReminder(tokenValue: unknown, rateLimitKey: string) {
    const token = this.cleanGuestToken(tokenValue);
    this.enforceGuestRateLimit(rateLimitKey);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { data: tokenRow, error: tokenError } = await this.supabase.db.from('guest_reminder_tokens').select('scheduled_action_id,expires_at,revoked_at').eq('token_hash', tokenHash).maybeSingle();
    if (tokenError) throw new ServiceUnavailableException(`Could not check reminder access: ${tokenError.message}`);
    if (!tokenRow || tokenRow.revoked_at || Date.parse(tokenRow.expires_at) <= Date.now()) throw new NotFoundException('This reminder link is invalid, expired, or revoked.');
    const { data: action, error } = await this.supabase.db.from('scheduled_actions').select('id,creator_user_id,task_id,recipient_name,message,scheduled_at,status,acknowledged_at').eq('id', tokenRow.scheduled_action_id).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load reminder: ${error.message}`);
    if (!action) throw new NotFoundException('This reminder link is invalid, expired, or revoked.');
    const { data: profile, error: profileError } = await this.supabase.db.from('profiles').select('username').eq('id', action.creator_user_id).maybeSingle();
    if (profileError) throw new ServiceUnavailableException(`Could not load reminder sender: ${profileError.message}`);
    const taskData = action.task_id ? await this.store.read(`user:${action.creator_user_id}`) : undefined;
    const taskStatus = taskData?.tasks.find((task) => task.id === action.task_id)?.status || null;
    return { id: action.id, recipientName: action.recipient_name, message: action.message, scheduledAt: Date.parse(action.scheduled_at), senderName: profile?.username || 'A Spectre user', deliveryStatus: action.status, acknowledgedAt: action.acknowledged_at ? Date.parse(action.acknowledged_at) : null, taskStatus };
  }

  async acknowledgeGuestReminder(tokenValue: unknown, rateLimitKey: string) {
    const token = this.cleanGuestToken(tokenValue);
    this.enforceGuestRateLimit(rateLimitKey);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { data, error } = await this.supabase.db.rpc('acknowledge_guest_reminder', { p_token_hash: tokenHash });
    if (error) {
      if (error.code === 'P0002') throw new NotFoundException('This reminder link is invalid, expired, or revoked.');
      throw new ServiceUnavailableException(`Could not acknowledge reminder: ${error.message}`);
    }
    return data;
  }

  async revokeGuestReminderAccess(userId: string, actionId: string) {
    const action = await this.getAction(userId, actionId);
    const { error } = await this.supabase.db.from('guest_reminder_tokens').update({ revoked_at: new Date().toISOString() }).eq('scheduled_action_id', action.id).is('revoked_at', null);
    if (error) throw new ServiceUnavailableException(`Could not revoke reminder access: ${error.message}`);
    return { id: action.id, revoked: true };
  }

  async cancelAction(userId: string, actionId: string) {
    const action = await this.getAction(userId, actionId);
    if (!['scheduled', 'failed'].includes(action.status)) throw new BadRequestException('Only scheduled or failed reminders can be cancelled.');
    const { data, error } = await this.supabase.db.from('scheduled_actions').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', actionId).eq('creator_user_id', userId).in('status', ['scheduled', 'failed']).select('*').maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not cancel reminder: ${error.message}`);
    if (!data) throw new BadRequestException('This reminder is already processing or finished.');
    await this.supabase.db.from('guest_reminder_tokens').update({ revoked_at: new Date().toISOString() }).eq('scheduled_action_id', actionId).is('revoked_at', null);
    return this.actionFromRow(data);
  }

  async sendEmail(to: string, subject: string, text: string, html: string) {
    const key = process.env.RESEND_API_KEY?.trim(); const from = process.env.EMAIL_FROM?.trim();
    if (!key || !from) throw new Error('Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text, html }) });
    if (!response.ok) {
      let detail = '';
      try { const payload = await response.json(); detail = typeof payload?.message === 'string' ? `: ${payload.message.slice(0, 300)}` : ''; } catch { /* provider returned no JSON error body */ }
      throw new Error(`Resend rejected the message (${response.status})${detail}.`);
    }
  }

  async getNotification(userId: string, id: string) {
    const { data, error } = await this.supabase.db.from('notifications').select('*').eq('id', id).eq('recipient_user_id', userId).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load notification: ${error.message}`);
    if (!data) throw new NotFoundException('Notification not found.');
    return this.notificationFromRow(data);
  }

  async listNotifications(userId: string) {
    const { data, error } = await this.supabase.db.from('notifications').select('*').eq('recipient_user_id', userId).order('created_at', { ascending: false }).limit(50);
    if (error) throw new ServiceUnavailableException(`Could not load notifications: ${error.message}`);
    return { notifications: data.map((row) => this.notificationFromRow(row)), unreadCount: data.filter((row) => !row.read_at).length };
  }

  async markNotificationRead(userId: string, id: string) {
    const { data, error } = await this.supabase.db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_user_id', userId).is('read_at', null).select('*').maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not update notification: ${error.message}`);
    if (data) return this.notificationFromRow(data);
    return this.getNotification(userId, id);
  }

  async markAllNotificationsRead(userId: string) {
    const { error } = await this.supabase.db.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_user_id', userId).is('read_at', null);
    if (error) throw new ServiceUnavailableException(`Could not update notifications: ${error.message}`);
    return { status: 'ok' };
  }

  encodeSession(session: { access_token: string; refresh_token: string }) { return Buffer.from(JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token })).toString('base64url'); }
  private async getActionByRequestId(userId: string, clientRequestId: string) {
    const { data, error } = await this.supabase.db.from('scheduled_actions').select('*').eq('creator_user_id', userId).eq('client_request_id', clientRequestId).single();
    if (error) throw new ServiceUnavailableException(`Could not retrieve reminder: ${error.message}`);
    return this.actionFromRow(data);
  }
  private actionFromRow(row: any) { return { id: row.id, clientRequestId: row.client_request_id, creatorUserId: row.creator_user_id, taskId: row.task_id || null, recipientName: row.recipient_name, recipientEmail: row.recipient_email, recipientUserId: null, subject: row.subject, message: row.message, scheduledAt: Date.parse(row.scheduled_at), timezone: row.timezone, status: row.status === 'sending' ? 'processing' : row.status === 'completed' ? 'sent' : row.status, createdAt: Date.parse(row.created_at), failureReason: row.failure_reason, attemptCount: row.attempt_count || 0, emailSentAt: row.email_sent_at ? Date.parse(row.email_sent_at) : undefined, acknowledgedAt: row.acknowledged_at ? Date.parse(row.acknowledged_at) : null, acknowledgmentSource: row.acknowledgment_source || null, attemptedAt: row.attempted_at ? Date.parse(row.attempted_at) : undefined, completedAt: row.completed_at ? Date.parse(row.completed_at) : undefined }; }
  private async setLinkedTaskPending(userId: string, taskId: string) {
    const scope = `user:${userId}`;
    const data = await this.store.read(scope);
    const task = data.tasks.find((item) => item.id === taskId);
    if (task?.status === 'To Do') { task.status = 'Pending'; await this.store.write(data, scope); }
  }
  private notificationFromRow(row: any) { return { id: row.id, recipientUserId: row.recipient_user_id, type: row.notification_type, title: row.title, message: row.message, relatedTaskId: row.related_task_id || null, relatedScheduledActionId: row.related_scheduled_action_id, readAt: row.read_at ? Date.parse(row.read_at) : null, createdAt: Date.parse(row.created_at) }; }
  private cleanGuestToken(value: unknown) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(value)) throw new NotFoundException('This reminder link is invalid, expired, or revoked.');
    return value;
  }
  private enforceGuestRateLimit(key: string) {
    const now = Date.now();
    if (this.guestRequestWindows.size > 2000) for (const [id, window] of this.guestRequestWindows) if (now - window.startedAt > 60_000) this.guestRequestWindows.delete(id);
    const current = this.guestRequestWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) this.guestRequestWindows.set(key, { startedAt: now, count: 1 });
    else if (current.count >= 30) throw new HttpException('Too many reminder-link requests. Please wait a minute and try again.', 429);
    else current.count += 1;
  }
  private missingEmailConfiguration() {
    const missing: string[] = [];
    if (!process.env.RESEND_API_KEY?.trim()) missing.push('RESEND_API_KEY');
    if (!process.env.EMAIL_FROM?.trim()) missing.push('EMAIL_FROM');
    if (process.env.NODE_ENV === 'production' && !process.env.APP_URL?.trim()) missing.push('APP_URL');
    return missing;
  }
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
      if (request.path === '/api/health' || request.path === '/api/health/supabase' || request.path.startsWith('/api/guest/reminders/')) return next();
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
