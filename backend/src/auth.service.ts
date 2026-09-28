import { BadRequestException, Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { JsonStore, ScopeContext } from './store';

type User = { id: string; email: string; passwordHash: string; createdAt: number; updatedAt: number };
type AuthData = { users: User[]; scheduledActions: Record<string, any>[]; invitations: Record<string, any>[] };
export type RequestIdentity = { type: 'user'; id: string } | { type: 'guest'; deviceId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthService {
  private readonly path = process.env.SPECTRE_AUTH_FILE || join(process.cwd(), '.data', 'spectre-auth.json');
  private readonly secret = process.env.SPECTRE_SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'development-only-spectre-secret-change-me');
  constructor(private readonly store: JsonStore) {}

  identityFromCookie(cookieHeader: string | undefined): RequestIdentity | undefined {
    const token = cookieHeader?.split(';').map((item) => item.trim()).find((item) => item.startsWith('spectre_session='))?.slice('spectre_session='.length);
    if (!token) return undefined;
    const userId = this.verifySession(decodeURIComponent(token));
    return { type: 'user', id: userId };
  }

  createGuestIdentity(value: unknown): RequestIdentity {
    if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException('A valid device ID is required.');
    return { type: 'guest', deviceId: value.toLowerCase() };
  }

  async register(input: Record<string, any>, deviceId: string) {
    const email = this.cleanEmail(input.email); const password = this.cleanPassword(input.password);
    const data = this.read();
    if (data.users.some((user) => user.email === email)) throw new BadRequestException('An account with this email already exists.');
    const user: User = { id: randomBytes(16).toString('hex'), email, passwordHash: this.hashPassword(password), createdAt: Date.now(), updatedAt: Date.now() };
    data.users.push(user);
    let acceptedInvitation: any;
    if (input.invitationToken) {
      acceptedInvitation = data.invitations.find((invite) => invite.token === input.invitationToken);
      if (!acceptedInvitation || acceptedInvitation.status !== 'pending' || acceptedInvitation.expiresAt <= Date.now() || acceptedInvitation.recipientEmail !== email) {
        throw new BadRequestException('This invitation is invalid, expired, or belongs to another email address.');
      }
      acceptedInvitation.status = 'accepted'; acceptedInvitation.acceptedAt = Date.now();
    }
    this.write(data);
    this.store.copyGuestToAccount(deviceId, user.id);
    return { user: this.publicUser(user), session: this.issueSession(user.id) };
  }

  login(input: Record<string, any>) {
    const email = this.cleanEmail(input.email); const password = this.cleanPassword(input.password, false);
    const user = this.read().users.find((candidate) => candidate.email === email);
    if (!user || !this.passwordMatches(password, user.passwordHash)) throw new UnauthorizedException('Email or password is incorrect.');
    return { user: this.publicUser(user), session: this.issueSession(user.id) };
  }

  getUser(id: string) { const user = this.read().users.find((candidate) => candidate.id === id); return user ? this.publicUser(user) : null; }
  findUserByEmail(email: string) { const user = this.read().users.find((candidate) => candidate.email === email.toLowerCase().trim()); return user ? this.publicUser(user) : null; }

  createAction(userId: string, input: Record<string, any>) {
    if (input.confirmed !== true) throw new BadRequestException('Confirm the reminder before scheduling it.');
    const data = this.read();
    if (typeof input.clientRequestId === 'string') {
      const prior = data.scheduledActions.find((action) => action.creatorUserId === userId && action.clientRequestId === input.clientRequestId);
      if (prior) return prior;
    }
    const recipientName = this.required(input.recipientName, 'Recipient name');
    const recipientEmail = this.cleanEmail(input.recipientEmail);
    const subject = this.required(input.subject, 'Subject'); const message = this.required(input.message, 'Message');
    const scheduledAt = typeof input.scheduledAt === 'string' ? Date.parse(input.scheduledAt) : NaN;
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) throw new BadRequestException('Reminder time must be in the future.');
    const timezone = this.required(input.timezone, 'Timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new BadRequestException('A valid timezone is required.'); }
    const action = { id: randomBytes(16).toString('hex'), clientRequestId: typeof input.clientRequestId === 'string' ? input.clientRequestId.slice(0, 100) : null, creatorUserId: userId, recipientName, recipientEmail, recipientUserId: data.users.find((user) => user.email === recipientEmail)?.id || null, subject, message, scheduledAt, timezone, status: 'scheduled', createdAt: Date.now(), failureReason: null };
    data.scheduledActions.push(action); this.write(data); return action;
  }
  listActions(userId: string) { return this.read().scheduledActions.filter((action) => action.creatorUserId === userId).sort((a, b) => a.scheduledAt - b.scheduledAt); }
  getAction(userId: string, id: string) { const action = this.read().scheduledActions.find((item) => item.id === id && item.creatorUserId === userId); if (!action) throw new UnauthorizedException('Scheduled action not found.'); return action; }

  async createInvitation(userId: string, input: Record<string, any>) {
    const recipientName = this.required(input.recipientName, 'Recipient name'); const recipientEmail = this.cleanEmail(input.recipientEmail);
    const data = this.read();
    if (data.users.some((user) => user.email === recipientEmail)) throw new BadRequestException('This recipient already has an account.');
    const invitation = { id: randomBytes(16).toString('hex'), senderUserId: userId, recipientEmail, recipientName, token: randomBytes(32).toString('base64url'), createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, status: 'pending' };
    data.invitations.push(invitation); this.write(data); return invitation;
  }
  listInvitations(userId: string) { return this.read().invitations.filter((invite) => invite.senderUserId === userId).map(({ token, senderUserId: _senderId, ...invite }) => invite); }
  cancelInvitation(userId: string, id: string) {
    const data = this.read(); const invite = data.invitations.find((item) => item.id === id && item.senderUserId === userId);
    if (!invite) throw new UnauthorizedException('Invitation not found.');
    if (invite.status === 'pending') invite.status = 'cancelled'; this.write(data); return invite;
  }
  acceptInvitation(userId: string, token: string) {
    const data = this.read(); const invite = data.invitations.find((item) => item.token === token);
    const user = data.users.find((item) => item.id === userId);
    if (!invite || !user || invite.status !== 'pending' || invite.expiresAt <= Date.now() || invite.recipientEmail !== user.email) throw new BadRequestException('This invitation is invalid, expired, or belongs to another email address.');
    invite.status = 'accepted'; invite.acceptedAt = Date.now(); this.write(data); return { status: invite.status };
  }
  invitationByToken(token: string) {
    const data = this.read(); const invite = data.invitations.find((item) => item.token === token);
    if (!invite) throw new UnauthorizedException('Invitation not found.');
    if (invite.status === 'pending' && invite.expiresAt <= Date.now()) { invite.status = 'expired'; this.write(data); }
    const { token: _token, senderUserId: _senderId, ...safe } = invite; return safe;
  }

  async sendInvitationMail(invitation: Record<string, any>) {
    const appName = process.env.APP_NAME || 'Spectre'; const baseUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
    const link = `${baseUrl}/?invite=${encodeURIComponent(invitation.token)}`;
    await this.sendEmail(invitation.recipientEmail, `Invitation to ${appName}`, `Hi ${invitation.recipientName},\n\nYou have been invited to join ${appName}. Create your account with this email address using this link:\n${link}\n\nThis link expires in 7 days.`);
  }
  async sendEmail(to: string, subject: string, text: string) {
    const key = process.env.SENDGRID_API_KEY; const from = process.env.EMAIL_FROM;
    if (!key || !from) throw new Error('Email delivery is not configured. Set SENDGRID_API_KEY and EMAIL_FROM.');
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject, content: [{ type: 'text/plain', value: text }] }) });
    if (!response.ok) throw new Error(`Email provider rejected the message (${response.status}).`);
  }

  private read(): AuthData {
    if (!existsSync(this.path)) { const directory = dirname(this.path); if (!existsSync(directory)) mkdirSync(directory, { recursive: true }); return { users: [], scheduledActions: [], invitations: [] }; }
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    return { users: data.users || [], scheduledActions: data.scheduledActions || [], invitations: data.invitations || [] };
  }
  write(data: AuthData) { const directory = dirname(this.path); if (!existsSync(directory)) mkdirSync(directory, { recursive: true }); const temporary = `${this.path}.tmp`; writeFileSync(temporary, JSON.stringify(data, null, 2)); renameSync(temporary, this.path); }
  claimDueActions() {
    const data = this.read(); const now = Date.now();
    data.invitations.forEach((invite) => { if (invite.status === 'pending' && invite.expiresAt <= now) invite.status = 'expired'; });
    const due = data.scheduledActions.filter((action) => action.status === 'scheduled' && action.scheduledAt <= now);
    due.forEach((action) => { action.status = 'sending'; action.attemptedAt = now; });
    if (due.length) this.write(data);
    return due;
  }
  finishAction(id: string, error?: string) {
    const data = this.read(); const action = data.scheduledActions.find((item) => item.id === id && item.status === 'sending');
    if (!action) return; action.status = error ? 'failed' : 'completed'; action.failureReason = error || null; action.completedAt = Date.now(); this.write(data);
  }

  private publicUser(user: User) { return { id: user.id, email: user.email, createdAt: user.createdAt, updatedAt: user.updatedAt }; }
  private cleanEmail(value: unknown) { if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new BadRequestException('A valid email address is required.'); return value.trim().toLowerCase(); }
  private cleanPassword(value: unknown, enforce = true) { if (typeof value !== 'string' || (enforce && value.length < 8) || value.length > 256) throw new BadRequestException(enforce ? 'Password must be between 8 and 256 characters.' : 'Password is required.'); return value; }
  private required(value: unknown, label: string) { if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new BadRequestException(`${label} is required.`); return value.trim(); }
  private hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
  private passwordMatches(password: string, stored: string) { const [, salt, expectedHex] = stored.split(':'); const expected = Buffer.from(expectedHex || '', 'hex'); const actual = scryptSync(password, salt || '', 64); return expected.length === actual.length && timingSafeEqual(expected, actual); }
  private issueSession(userId: string) {
    if (!this.secret) throw new Error('SPECTRE_SESSION_SECRET must be configured in production.');
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.secret).update(payload).digest('base64url')}`;
  }
  private verifySession(token: string) {
    if (!this.secret) throw new UnauthorizedException('Session validation is unavailable.');
    const [payload, signature] = token.split('.'); const expected = createHmac('sha256', this.secret).update(payload || '').digest();
    let actual: Buffer; try { actual = Buffer.from(signature || '', 'base64url'); } catch { throw new UnauthorizedException('Invalid session.'); }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new UnauthorizedException('Invalid session.');
    try { const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (!parsed.sub || parsed.exp <= Date.now()) throw new Error(); return parsed.sub as string; } catch { throw new UnauthorizedException('Session expired.'); }
  }
}

@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService, private readonly scopes: ScopeContext) {}
  use(request: Request & { identity?: RequestIdentity }, response: Response, next: NextFunction) {
    if (request.path === '/api/health') return next();
    try {
      const identity = this.auth.identityFromCookie(request.headers.cookie);
      request.identity = identity || this.auth.createGuestIdentity(request.headers['x-device-id']);
      const scope = request.identity.type === 'user' ? `user:${request.identity.id}` : `guest:${request.identity.deviceId}`;
      this.scopes.run(scope, next);
    } catch (error) { next(error); }
  }
}
