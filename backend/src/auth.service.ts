import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NestMiddleware, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SupabaseStore, ScopeContext } from './store';
import { SupabaseService } from './supabase.service';
import { PushService } from './push.service';

type SessionCookie = { access_token: string; refresh_token: string };
type GuestAccount = { id: string; device_id: string; created_at: string };
export type RequestIdentity = { type: 'user'; id: string; email?: string; emailVerified?: boolean } | { type: 'guest'; deviceId: string; guestUserId?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly guestRequestWindows = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly supabase: SupabaseService, private readonly store: SupabaseStore, private readonly push: PushService) {}

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
    return { identity: { type: 'user' as const, id: data.user.id, email: data.user.email, emailVerified: this.isEmailVerified(data.user) }, session: refreshed && this.encodeSession(refreshed) };
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

  async exchangeGoogleSession(input: Record<string, any>) {
    const accessToken = typeof input.accessToken === 'string' ? input.accessToken : '';
    const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken : '';
    if (!accessToken || !refreshToken || accessToken.length > 8192 || refreshToken.length > 4096) throw new UnauthorizedException('Google sign-in did not return a valid session. Please try again.');
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    if (error || !data.user) throw new UnauthorizedException('Google sign-in session could not be verified. Please try again.');
    const googleIdentity = data.user.app_metadata?.provider === 'google' || (Array.isArray(data.user.identities) && data.user.identities.some((identity: any) => identity.provider === 'google'));
    if (!googleIdentity) throw new UnauthorizedException('This sign-in session is not connected to Google.');
    return { user: this.publicUser(data.user), session: this.encodeSession({ access_token: accessToken, refresh_token: refreshToken }) };
  }

  async googleLinkSession(cookieHeader?: string) {
    const result = await this.identityFromCookie(cookieHeader);
    if (!result || result.identity.type !== 'user') throw new UnauthorizedException('Sign in before connecting Google Calendar.');
    const current = this.readCookie(cookieHeader, 'spectre_session');
    if (!current) throw new UnauthorizedException('Your session expired. Please log in again.');
    const stored = JSON.parse(Buffer.from(decodeURIComponent(current), 'base64url').toString('utf8')) as SessionCookie;
    const refreshed = result.session ? JSON.parse(Buffer.from(result.session, 'base64url').toString('utf8')) as SessionCookie : undefined;
    return { user: await this.getUser(result.identity.id), session: refreshed || stored };
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

  async changePassword(userId: string, input: Record<string, any>) {
    const currentPassword = this.cleanPassword(input.currentPassword, false);
    const newPassword = this.cleanPassword(input.newPassword);
    if (currentPassword === newPassword) throw new BadRequestException('Choose a password different from your current password.');
    const { data: userData, error: userError } = await this.supabase.auth.admin.getUserById(userId);
    if (userError || !userData.user?.email) throw new UnauthorizedException('Your session is no longer valid. Please log in again.');
    const verified = await this.supabase.newClient().auth.signInWithPassword({ email: userData.user.email, password: currentPassword });
    if (verified.error) throw new UnauthorizedException('Your current password is incorrect.');
    const { error } = await this.supabase.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) throw new ServiceUnavailableException(`Could not update password: ${error.message}`);
    return { status: 'ok' };
  }

  async transferGuestData(userId: string, guestUserId: string, confirmed: boolean) {
    if (!confirmed) throw new BadRequestException('Confirm the guest data transfer before continuing.');
    if (!(await this.getUser(userId))) throw new UnauthorizedException('Authenticated account not found.');
    const guest = await this.getGuestAccount(guestUserId);
    if (!guest) throw new BadRequestException('The guest account is no longer available.');
    const { data: claim, error: claimError } = await this.supabase.db.from('guest_accounts')
      .update({ transferred_to_user_id: userId })
      .eq('id', guestUserId)
      .or(`transferred_to_user_id.is.null,transferred_to_user_id.eq.${userId}`)
      .select('id')
      .maybeSingle();
    if (claimError) throw new ServiceUnavailableException('Guest tasks could not be linked to this account. Please try again.');
    if (!claim) {
      const { data: existingClaim, error: lookupError } = await this.supabase.db.from('guest_accounts').select('transferred_to_user_id').eq('id', guestUserId).maybeSingle();
      if (lookupError) throw new ServiceUnavailableException('Guest account ownership could not be checked. Please try again.');
      if (existingClaim?.transferred_to_user_id && existingClaim.transferred_to_user_id !== userId) {
        throw new ConflictException('These guest tasks were already transferred to another account. Sign in to that account to access them.');
      }
      throw new BadRequestException('The guest account is no longer available. Refresh the app and try again.');
    }
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
    const destinationSummaries = destination.weeklySummaries ?? (destination.weeklySummaries = []);
    for (const sourceSummary of source.weeklySummaries || []) {
      const existing = destinationSummaries.find((summary) => summary.weekStart === sourceSummary.weekStart);
      if (!existing) destinationSummaries.push(sourceSummary);
      else {
        const knownTasks = new Set((existing.tasks || []).map((task: Record<string, any>) => task.id || taskFingerprint(task)));
        existing.tasks = [...(existing.tasks || []), ...(sourceSummary.tasks || []).filter((task: Record<string, any>) => !knownTasks.has(task.id || taskFingerprint(task)))];
        if (!existing.viewedAt) existing.viewedAt = sourceSummary.viewedAt || null;
      }
    }
    if (source.weeklySummaryThrough && (!destination.weeklySummaryThrough || source.weeklySummaryThrough > destination.weeklySummaryThrough)) destination.weeklySummaryThrough = source.weeklySummaryThrough;
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

  async listNotifications(userId: string, offset = 0) {
    const start = Math.max(0, Math.floor(offset));
    const [page, unread] = await Promise.all([
      this.supabase.db.from('notifications').select('*').eq('recipient_user_id', userId).order('created_at', { ascending: false }).range(start, start + 49),
      this.supabase.db.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_user_id', userId).is('read_at', null),
    ]);
    if (page.error || unread.error) throw new ServiceUnavailableException('Could not load notifications.');
    return { notifications: page.data.map((row) => this.notificationFromRow(row)), unreadCount: unread.count || 0, hasMore: page.data.length === 50 };
  }

  async listGuestNotifications(scope: string, offset = 0) {
    const start = Math.max(0, Math.floor(offset));
    const [page, unread] = await Promise.all([
      this.supabase.db.from('notifications').select('*').eq('recipient_scope', scope).order('created_at', { ascending: false }).range(start, start + 49),
      this.supabase.db.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_scope', scope).is('read_at', null),
    ]);
    if (page.error || unread.error) throw new ServiceUnavailableException('Could not load notifications.');
    return { notifications: page.data.map((row) => this.notificationFromRow(row)), unreadCount: unread.count || 0, hasMore: page.data.length === 50 };
  }

  async markGuestNotificationRead(scope: string, id: string) {
    const { data, error } = await this.supabase.db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_scope', scope).is('read_at', null).select('*').maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not update notification: ${error.message}`);
    if (data) return this.notificationFromRow(data);
    const { data: existing, error: lookupError } = await this.supabase.db.from('notifications').select('*').eq('id', id).eq('recipient_scope', scope).maybeSingle();
    if (lookupError) throw new ServiceUnavailableException(`Could not load notification: ${lookupError.message}`);
    if (!existing) throw new NotFoundException('Notification not found.');
    return this.notificationFromRow(existing);
  }

  async markGuestNotificationsRead(scope: string) {
    const { error } = await this.supabase.db.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_scope', scope).is('read_at', null);
    if (error) throw new ServiceUnavailableException(`Could not update notifications: ${error.message}`);
    return { status: 'ok' };
  }

  async getNotificationPreferences(scope: string) {
    const { data, error } = await this.supabase.db.from('notification_preferences').select('*').eq('owner_scope', scope).maybeSingle();
    if (error) throw new ServiceUnavailableException(`Could not load notification settings: ${error.message}`);
    return this.notificationPreferencesFromRow(data);
  }

  async updateNotificationPreferences(scope: string, input: Record<string, unknown>) {
    const current = await this.getNotificationPreferences(scope);
    const next = {
      owner_scope: scope,
      in_app: typeof input.inApp === 'boolean' ? input.inApp : current.inApp,
      browser_push: typeof input.browserPush === 'boolean' ? input.browserPush : current.browserPush,
      task_reminders: typeof input.taskReminders === 'boolean' ? input.taskReminders : current.taskReminders,
      collaboration_updates: typeof input.collaborationUpdates === 'boolean' ? input.collaborationUpdates : current.collaborationUpdates,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.supabase.db.from('notification_preferences').upsert(next, { onConflict: 'owner_scope' }).select('*').single();
    if (error) throw new ServiceUnavailableException(`Could not save notification settings: ${error.message}`);
    return this.notificationPreferencesFromRow(data);
  }

  async savePushSubscription(scope: string, input: Record<string, any>) {
    if (!this.push.available) throw new BadRequestException('Browser notifications are not available right now.');
    const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
    const p256dh = typeof input.keys?.p256dh === 'string' ? input.keys.p256dh : '';
    const auth = typeof input.keys?.auth === 'string' ? input.keys.auth : '';
    if (endpoint.length > 2048 || p256dh.length > 256 || auth.length > 128) throw new BadRequestException('This browser notification subscription is not valid.');
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new BadRequestException('This browser notification subscription is not valid.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(parsed.hostname)) throw new BadRequestException('This browser notification subscription is not valid.');
    if (!p256dh || !auth) throw new BadRequestException('This browser did not provide the required notification keys.');
    const { error } = await this.supabase.db.from('push_subscriptions').upsert({ owner_scope: scope, endpoint, p256dh, auth, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (error) throw new ServiceUnavailableException('Could not save browser notification settings.');
    const { error: prefError } = await this.supabase.db.from('notification_preferences').upsert({ owner_scope: scope, browser_push: true, updated_at: new Date().toISOString() }, { onConflict: 'owner_scope' });
    if (prefError) throw new ServiceUnavailableException('Could not save browser notification settings.');
    return { status: 'ok' };
  }

  async removePushSubscription(scope: string, endpoint?: string) {
    let query = this.supabase.db.from('push_subscriptions').delete().eq('owner_scope', scope);
    if (endpoint) query = query.eq('endpoint', endpoint);
    const { error } = await query;
    if (error) throw new ServiceUnavailableException('Could not turn off browser notifications.');
    if (!endpoint) {
      const { error: prefError } = await this.supabase.db.from('notification_preferences').upsert({ owner_scope: scope, browser_push: false, updated_at: new Date().toISOString() }, { onConflict: 'owner_scope' });
      if (prefError) throw new ServiceUnavailableException('Could not turn off browser notifications.');
    }
    return { status: 'ok' };
  }

  async processDueTaskNotifications() {
    const { data: owners, error } = await this.supabase.db.from('spectre_data').select('owner_key,data,revision');
    if (error) throw new ServiceUnavailableException(`Could not check task reminders: ${error.message}`);
    const now = Date.now();
    for (const owner of owners || []) {
      const tasks: Record<string, any>[] = Array.isArray(owner.data?.tasks) ? owner.data.tasks : [];
      const { data: savedPreferences, error: preferencesError } = await this.supabase.db.from('notification_preferences').select('in_app,browser_push,task_reminders').eq('owner_scope', owner.owner_key).maybeSingle();
      if (preferencesError) throw new ServiceUnavailableException(`Could not check notification settings: ${preferencesError.message}`);
      const remindersEnabled = ((savedPreferences?.in_app ?? true) || (savedPreferences?.browser_push ?? false)) && (savedPreferences?.task_reminders ?? true);
      let changed = false;
      for (const task of tasks) {
        if (!task.reminder || !task.due || task.status === 'Completed' || task.notified) continue;
        const dueAt = Date.parse(task.reminderAt || task.due);
        const leadMs = task.reminder === 'at-due' ? 0 : Number(task.reminder) * 60_000;
        if (!Number.isFinite(dueAt) || !Number.isFinite(leadMs) || dueAt - leadMs > now) continue;
        let dueLabel = new Date(dueAt).toISOString();
        try { dueLabel = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: task.reminderTimezone || 'UTC' }).format(new Date(dueAt)); } catch {}
        const reminderMessage = `This task is due ${task.reminder === 'at-due' ? 'now' : 'soon'} (scheduled for ${dueLabel}).`;
        const dedupeKey = `task-reminder:${owner.owner_key}:${task.id}:${task.due}:${task.reminder}`;
        if (remindersEnabled) {
          const { error: insertError } = await this.supabase.db.from('notifications').insert({
          recipient_user_id: owner.owner_key.startsWith('user:') ? owner.owner_key.slice(5) : null,
          recipient_scope: owner.owner_key,
          notification_type: 'task_reminder',
          title: task.title || 'Task reminder',
          message: reminderMessage,
          related_task_id: task.id,
          dedupe_key: dedupeKey,
          push_next_attempt_at: savedPreferences?.browser_push ? new Date().toISOString() : null,
          });
          if (insertError && insertError.code !== '23505') throw new ServiceUnavailableException(`Could not save a task reminder: ${insertError.message}`);
        }
        task.notified = true;
        changed = true;
      }
      if (changed) {
        const { error: updateError } = await this.supabase.db.from('spectre_data').update({ data: owner.data, revision: owner.revision + 1, updated_at: new Date().toISOString() }).eq('owner_key', owner.owner_key).eq('revision', owner.revision);
        if (updateError) this.logger.warn(`Could not mark due reminders as processed for ${owner.owner_key}: ${updateError.message}`);
      }
    }
    await this.processPendingPushNotifications();
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
  private notificationPreferencesFromRow(row: any) { return { inApp: row?.in_app ?? true, browserPush: row?.browser_push ?? false, taskReminders: row?.task_reminders ?? true, collaborationUpdates: row?.collaboration_updates ?? true, browserPushAvailable: this.push.available, browserPushPublicKey: this.push.publicKey }; }
  private async processPendingPushNotifications() {
    if (!this.push.available) return;
    const now = new Date().toISOString();
    const { data: due, error } = await this.supabase.db.from('notifications').select('id,recipient_scope,title,message,related_task_id,push_attempt_count,push_next_attempt_at').eq('notification_type', 'task_reminder').is('push_sent_at', null).not('push_next_attempt_at', 'is', null).lte('push_next_attempt_at', now).limit(100);
    if (error) throw new ServiceUnavailableException('Could not check pending browser notifications.');
    for (const item of due || []) {
      const attempts = Number(item.push_attempt_count) || 0;
      const leaseUntil = new Date(Date.now() + 60_000).toISOString();
      const { data: claimed, error: claimError } = await this.supabase.db.from('notifications').update({ push_attempt_count: attempts + 1, push_next_attempt_at: leaseUntil }).eq('id', item.id).eq('push_attempt_count', attempts).is('push_sent_at', null).lte('push_next_attempt_at', now).select('id').maybeSingle();
      if (claimError || !claimed) continue;
      const { data: prefs, error: preferenceError } = await this.supabase.db.from('notification_preferences').select('browser_push').eq('owner_scope', item.recipient_scope).maybeSingle();
      if (!preferenceError && !prefs?.browser_push) {
        await this.supabase.db.from('notifications').update({ push_sent_at: new Date().toISOString(), push_next_attempt_at: null }).eq('id', item.id);
        continue;
      }
      const result = preferenceError ? { subscriptions: 1, failed: 1 } : await this.sendPushToOwner(item.recipient_scope, { title: item.title, body: item.message, taskId: item.related_task_id });
      if (result.failed === 0 || result.subscriptions === 0) {
        await this.supabase.db.from('notifications').update({ push_sent_at: new Date().toISOString(), push_next_attempt_at: null, push_failure_reason: null }).eq('id', item.id);
      } else if (attempts + 1 >= 5) {
        await this.supabase.db.from('notifications').update({ push_sent_at: new Date().toISOString(), push_next_attempt_at: null, push_failure_reason: 'Browser notification could not be delivered after several attempts.' }).eq('id', item.id);
      } else {
        const retryAt = new Date(Date.now() + Math.min(60_000 * (2 ** attempts), 30 * 60_000)).toISOString();
        await this.supabase.db.from('notifications').update({ push_next_attempt_at: retryAt, push_failure_reason: 'Temporary browser notification delivery issue.' }).eq('id', item.id);
      }
    }
  }

  private async sendPushToOwner(ownerScope: string, message: { title: string; body: string; taskId: string }) {
    const { data, error } = await this.supabase.db.from('push_subscriptions').select('endpoint,p256dh,auth').eq('owner_scope', ownerScope);
    if (error) { this.logger.warn('Could not load browser notification subscriptions.'); return { subscriptions: 0, failed: 1 }; }
    let failed = 0;
    const subscriptions = data || [];
    for (const subscription of data || []) {
      try {
        const result = await this.push.send(subscription, message);
        if (result.gone) await this.supabase.db.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
        if (!result.sent && !result.gone) failed += 1;
      } catch (error) { failed += 1; this.logger.warn(`Browser notification delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
    return { subscriptions: subscriptions.length, failed };
  }
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
  private publicUser(user: { id: string; email?: string; created_at?: string; updated_at?: string; email_confirmed_at?: string; identities?: Array<{ provider?: string; identity_data?: Record<string, any> }>; app_metadata?: Record<string, any>; user_metadata?: Record<string, any> }) { return { id: user.id, email: user.email, emailVerified: this.isEmailVerified(user), avatarUrl: typeof user.user_metadata?.avatar_url === 'string' ? user.user_metadata.avatar_url : undefined, displayName: typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : undefined, createdAt: user.created_at ? Date.parse(user.created_at) : Date.now(), updatedAt: user.updated_at ? Date.parse(user.updated_at) : Date.now() }; }
  private isEmailVerified(user: { email_confirmed_at?: string; identities?: Array<{ provider?: string; identity_data?: Record<string, any> }>; app_metadata?: Record<string, any>; user_metadata?: Record<string, any> }) {
    if (user.email_confirmed_at) return true;
    const google = user.identities?.find((identity) => identity.provider === 'google');
    return google?.identity_data?.email_verified === true || user.user_metadata?.email_verified === true;
  }
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
      // Credential exchange and sign-out must remain reachable when the browser
      // has an expired session cookie; otherwise users cannot replace that session.
      if (
        request.path === '/api/health' ||
        request.path === '/api/health/supabase' ||
        request.path === '/api/auth/login' ||
        request.path === '/api/auth/logout' ||
        request.path === '/api/auth/google/session' ||
        request.path.startsWith('/api/guest/reminders/')
      ) return next();
      try {
        let session: Awaited<ReturnType<AuthService['identityFromCookie']>> | undefined;
        try {
          session = await this.auth.identityFromCookie(request.headers.cookie);
        } catch (error) {
          if (!(error instanceof UnauthorizedException)) throw error;
          // An expired or invalid app session should stop being treated as logged in.
          // Clear it and let normal requests continue under the persistent guest identity.
          response.clearCookie('spectre_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
        }
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
