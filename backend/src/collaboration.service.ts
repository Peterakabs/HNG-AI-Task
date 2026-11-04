import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SpectreService } from './spectre.service';
import { SupabaseStore } from './store';
import { SupabaseService } from './supabase.service';

type Permission = 'viewer' | 'editor';

@Injectable()
export class CollaborationService {
  private readonly logger = new Logger(CollaborationService.name);
  constructor(private readonly supabase: SupabaseService, private readonly store: SupabaseStore, private readonly tasks: SpectreService) {}

  async createInvitation(ownerId: string, inviterEmail: string, taskId: string, input: Record<string, any>) {
    const task = await this.ownedTask(ownerId, taskId);
    const email = this.cleanEmail(input.email);
    if (!inviterEmail || email === inviterEmail.toLowerCase()) throw new BadRequestException('Choose another person’s email address.');
    const permission = input.permission === 'editor' ? 'editor' : input.permission === 'viewer' ? 'viewer' : null;
    if (!permission) throw new BadRequestException('Choose Viewer or Editor access.');
    const configuredBase = process.env.APP_URL?.trim();
    if (!configuredBase && process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Sharing links are not configured yet. Please try again later.');
    let base: URL;
    try { base = new URL(configuredBase || 'http://localhost:5173'); }
    catch { throw new ServiceUnavailableException('Sharing links are not configured yet. Please try again later.'); }
    if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') throw new ServiceUnavailableException('Secure sharing links are not configured yet. Please try again later.');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase.db.rpc('create_task_invitation', {
      p_task_id: taskId, p_owner_user_id: ownerId, p_inviter_user_id: ownerId,
      p_invitee_email: email, p_permission: permission, p_token_hash: tokenHash, p_expires_at: expiresAt,
    });
    if (error) {
      if (error.code === '23505' || /duplicate|already a collaborator/i.test(error.message)) throw new ConflictException('There is already an invitation or collaboration for this email.');
      if (/rate limit/i.test(error.message)) throw new ConflictException('You have created several invitations recently. Please try again in an hour.');
      throw new ServiceUnavailableException('The invitation link could not be created. Please try again.');
    }
    const row = Array.isArray(data) ? data[0] : data;
    const link = new URL('/', base);
    link.hash = `invite=${token}`;
    this.logger.log(`Created task invitation ${row?.id || 'unknown'} for task ${taskId}.`);
    return { id: row?.id, taskId, taskTitle: task.title, email, permission, expiresAt, invitationUrl: link.toString() };
  }

  async invitationDetails(userId: string, email: string, emailVerified: boolean, token: string) {
    this.requireVerifiedEmail(email, emailVerified);
    const row = await this.invitationByToken(token);
    if (email.toLowerCase() !== row.invitee_email) throw new ForbiddenException('This invitation was sent to a different email address. Sign in with the invited email.');
    if (row.status !== 'pending') throw new NotFoundException(`This invitation is ${row.status}.`);
    if (Date.parse(row.expires_at) <= Date.now()) {
      await this.supabase.db.from('task_invitations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'pending');
      throw new NotFoundException('This invitation has expired. Ask the owner to send a new link.');
    }
    if (row.task_owner_user_id === userId) throw new BadRequestException('You already own this task.');
    const task = await this.taskForOwner(row.task_owner_user_id, row.task_id);
    if (!task) throw new NotFoundException('This task is no longer available.');
    const inviter = await this.person(row.inviter_user_id, 'owner');
    return { invitationId: row.id, taskId: row.task_id, taskTitle: task.title, description: task.description || '', due: task.due || null, inviter, inviteeEmail: row.invitee_email, permission: row.permission, expiresAt: row.expires_at };
  }

  async acceptInvitation(userId: string, email: string, emailVerified: boolean, token: string) {
    this.requireVerifiedEmail(email, emailVerified);
    const before = await this.invitationByToken(token);
    if (email.toLowerCase() !== before.invitee_email) throw new ForbiddenException('This invitation was sent to a different email address. Sign in with the invited email.');
    if (!(await this.taskForOwner(before.task_owner_user_id, before.task_id))) throw new NotFoundException('This task is no longer available.');
    const { data, error } = await this.supabase.db.rpc('accept_task_invitation', { p_token_hash: this.hash(token), p_user_id: userId, p_email: email.toLowerCase() });
    if (error) {
      if (error.code === '42501') throw new ForbiddenException('This invitation cannot be accepted by this account.');
      throw new NotFoundException('This invitation is invalid, expired, or no longer available. Ask the owner for a new link.');
    }
    if (data?.expired) throw new NotFoundException('This invitation has expired. Ask the owner to send a new link.');
    this.logger.log(`User ${userId} accepted task invitation ${data.invitationId}.`);
    const task = await this.taskForOwner(data.ownerUserId, data.taskId);
    return { ...data, task: task ? { ...task, shared: true, sharedPermission: data.permission, taskOwnerId: data.ownerUserId } : null };
  }

  async declineInvitation(userId: string, email: string, emailVerified: boolean, token: string) {
    this.requireVerifiedEmail(email, emailVerified);
    const invite = await this.invitationByToken(token);
    if (email.toLowerCase() !== invite.invitee_email) throw new ForbiddenException('This invitation was sent to a different email address. Sign in with the invited email.');
    if (invite.status === 'declined') return { status: 'declined', alreadyDeclined: true };
    if (invite.status !== 'pending') throw new NotFoundException('This invitation is no longer available.');
    const { data, error } = await this.supabase.db.from('task_invitations').update({ status: 'declined', updated_at: new Date().toISOString() }).eq('id', invite.id).eq('status', 'pending').select('id').maybeSingle();
    if (error || !data) throw new NotFoundException('This invitation is no longer available.');
    await this.notify(invite.task_owner_user_id, 'collaboration_invitation_declined', 'Invitation declined', 'A task invitation was declined.', invite.task_id, `invite-declined:${invite.id}`, invite.id);
    return { status: 'declined' };
  }

  async revokeInvitation(ownerId: string, taskId: string, invitationId: string) {
    await this.ownedTask(ownerId, taskId);
    const { data, error } = await this.supabase.db.from('task_invitations').update({ status: 'revoked', updated_at: new Date().toISOString() }).eq('id', invitationId).eq('task_owner_user_id', ownerId).eq('task_id', taskId).eq('status', 'pending').select('id').maybeSingle();
    if (error) throw new ServiceUnavailableException('The invitation could not be revoked. Please try again.');
    if (!data) throw new NotFoundException('This pending invitation could not be found.');
    return { status: 'revoked' };
  }

  async sharedTasks(userId: string) {
    const { data, error } = await this.supabase.db.from('task_collaborators').select('task_id,task_owner_user_id,permission').eq('user_id', userId).order('joined_at', { ascending: false });
    if (error) throw new ServiceUnavailableException('Shared tasks could not be loaded. Please try again.');
    const tasks: Record<string, any>[] = [];
    for (const membership of data || []) {
      const task = await this.taskForOwner(membership.task_owner_user_id, membership.task_id);
      if (task) tasks.push({ ...task, shared: true, sharedPermission: membership.permission, taskOwnerId: membership.task_owner_user_id });
    }
    return tasks;
  }

  async sharedTaskForUser(userId: string, taskId: string) {
    const membership = await this.membership(userId, taskId);
    if (!membership) return null;
    const task = await this.taskForOwner(membership.task_owner_user_id, taskId);
    return task ? { ...task, shared: true, sharedPermission: membership.permission, taskOwnerId: membership.task_owner_user_id } : null;
  }

  async updateSharedTask(userId: string, taskId: string, input: Record<string, any>) {
    const membership = await this.membership(userId, taskId);
    if (!membership) throw new NotFoundException('Task not found.');
    if (membership.permission !== 'editor') throw new ForbiddenException('You have view-only access to this task.');
    const allowed: Record<string, any> = {};
    for (const key of ['title', 'description', 'due', 'status', 'priority', 'folder', 'tags', 'subtasks', 'attachments', 'notes', 'recurrence', 'reminder']) if (input[key] !== undefined) allowed[key] = input[key];
    const result = await this.tasks.updateTask(taskId, allowed, `user:${membership.task_owner_user_id}`, userId);
    await this.notifyTaskMembers(membership.task_owner_user_id, taskId, userId, 'collaboration_task_updated', 'Shared task updated', 'A shared task was updated.', `task-update:${randomUUID()}`);
    return { ...result, task: { ...result.task, shared: true, sharedPermission: membership.permission, taskOwnerId: membership.task_owner_user_id } };
  }

  async taskCollaboration(userId: string, taskId: string) {
    const owned = await this.taskForOwner(userId, taskId);
    const isOwner = Boolean(owned);
    const membership = isOwner ? null : await this.membership(userId, taskId);
    if (!isOwner && !membership) throw new NotFoundException('Task not found.');
    const ownerId = isOwner ? userId : membership!.task_owner_user_id;
    if (!owned && !(await this.taskForOwner(ownerId, taskId))) throw new NotFoundException('Task not found.');
    const { data: collaborators, error } = await this.supabase.db.from('task_collaborators').select('id,user_id,permission,joined_at').eq('task_owner_user_id', ownerId).eq('task_id', taskId).order('joined_at');
    if (error) throw new ServiceUnavailableException('Collaborators could not be loaded. Please try again.');
    const people: Array<{ userId: string; username: string; avatarUrl?: string; permission: string; id?: string; joinedAt?: string }> = [await this.person(ownerId, 'owner')];
    for (const item of collaborators || []) people.push({ ...(await this.person(item.user_id, item.permission)), id: item.id, joinedAt: item.joined_at });
    let invitations: any[] = [];
    if (isOwner) {
      const { data: invites, error: inviteError } = await this.supabase.db.from('task_invitations').select('id,invitee_email,permission,status,expires_at,created_at').eq('task_owner_user_id', ownerId).eq('task_id', taskId).in('status', ['pending','accepted','declined']).order('created_at', { ascending: false });
      if (inviteError) throw new ServiceUnavailableException('Invitations could not be loaded. Please try again.');
      invitations = (invites || []).map((item) => ({ id: item.id, email: item.invitee_email, permission: item.permission, status: item.status, expiresAt: item.expires_at, createdAt: item.created_at }));
    }
    return { isOwner, permission: membership?.permission || 'owner', collaborators: people, invitations };
  }

  async changePermission(ownerId: string, taskId: string, collaboratorId: string, permission: string) {
    await this.ownedTask(ownerId, taskId);
    if (!['viewer', 'editor'].includes(permission)) throw new BadRequestException('Choose Viewer or Editor access.');
    const { data, error } = await this.supabase.db.from('task_collaborators').update({ permission }).eq('id', collaboratorId).eq('task_owner_user_id', ownerId).eq('task_id', taskId).select('id,user_id,permission').maybeSingle();
    if (error) throw new ServiceUnavailableException('The permission could not be updated. Please try again.');
    if (!data) throw new NotFoundException('Collaborator not found.');
    return { id: data.id, permission: data.permission };
  }

  async removeCollaborator(ownerId: string, taskId: string, collaboratorId: string) {
    await this.ownedTask(ownerId, taskId);
    const { data, error } = await this.supabase.db.from('task_collaborators').delete().eq('id', collaboratorId).eq('task_owner_user_id', ownerId).eq('task_id', taskId).select('user_id').maybeSingle();
    if (error) throw new ServiceUnavailableException('The collaborator could not be removed. Please try again.');
    if (!data) throw new NotFoundException('Collaborator not found.');
    await this.notify(data.user_id, 'collaboration_access_removed', 'Task access removed', 'Your access to a shared task was removed.', taskId, `collaborator-removed:${collaboratorId}`);
    return { status: 'removed' };
  }

  async notifyOwnerTaskUpdated(ownerId: string, taskId: string) {
    await this.notifyTaskMembers(ownerId, taskId, ownerId, 'collaboration_task_updated', 'Shared task updated', 'A shared task was updated.', `owner-task-update:${randomUUID()}`);
  }

  async cleanupDeletedTask(ownerId: string, taskId: string) {
    const { data: members } = await this.supabase.db.from('task_collaborators').select('user_id').eq('task_owner_user_id', ownerId).eq('task_id', taskId);
    for (const member of members || []) await this.notify(member.user_id, 'collaboration_access_removed', 'Task access removed', 'The shared task is no longer available.', taskId, `task-deleted:${taskId}:${member.user_id}`);
    await Promise.all([
      this.supabase.db.from('task_collaborators').delete().eq('task_owner_user_id', ownerId).eq('task_id', taskId),
      this.supabase.db.from('task_invitations').update({ status: 'revoked', updated_at: new Date().toISOString() }).eq('task_owner_user_id', ownerId).eq('task_id', taskId).eq('status', 'pending'),
      this.supabase.db.from('task_comments').delete().eq('task_owner_user_id', ownerId).eq('task_id', taskId),
    ]);
  }

  async comments(userId: string, taskId: string) {
    const ownerId = await this.authorizedTaskOwner(userId, taskId, false);
    const { data, error } = await this.supabase.db.from('task_comments').select('*').eq('task_owner_user_id', ownerId).eq('task_id', taskId).order('created_at');
    if (error) throw new ServiceUnavailableException('Comments could not be loaded. Please try again.');
    return Promise.all((data || []).map(async (row) => ({ id: row.id, message: row.message, createdAt: row.created_at, author: await this.person(row.author_user_id, 'member') })));
  }

  async addComment(userId: string, taskId: string, messageValue: unknown) {
    const message = typeof messageValue === 'string' ? messageValue.trim() : '';
    if (!message || message.length > 2000) throw new BadRequestException('Write a comment of 1 to 2,000 characters.');
    const ownerId = await this.authorizedTaskOwner(userId, taskId, true);
    const { data, error } = await this.supabase.db.from('task_comments').insert({ task_owner_user_id: ownerId, task_id: taskId, author_user_id: userId, message }).select('*').single();
    if (error) throw new ServiceUnavailableException('Your comment could not be added. Please try again.');
    await this.notifyTaskMembers(ownerId, taskId, userId, 'collaboration_comment_added', 'New task comment', 'A collaborator added a comment.', `comment:${data.id}`);
    return { id: data.id, message: data.message, createdAt: data.created_at, author: await this.person(userId, 'member') };
  }

  private async authorizedTaskOwner(userId: string, taskId: string, canComment: boolean) {
    if (await this.taskForOwner(userId, taskId)) return userId;
    const membership = await this.membership(userId, taskId);
    if (!membership) throw new NotFoundException('Task not found.');
    if (canComment && membership.permission !== 'editor') throw new ForbiddenException('Viewers can read comments but cannot add them.');
    if (!(await this.taskForOwner(membership.task_owner_user_id, taskId))) throw new NotFoundException('Task not found.');
    return membership.task_owner_user_id;
  }
  private async ownedTask(ownerId: string, taskId: string) {
    const task = await this.taskForOwner(ownerId, taskId);
    if (!task) throw new NotFoundException('Task not found.');
    return task;
  }
  private async taskForOwner(ownerId: string, taskId: string) {
    try { return (await this.store.read(`user:${ownerId}`)).tasks.find((task) => task.id === taskId) || null; }
    catch { return null; }
  }
  private async membership(userId: string, taskId: string) {
    const { data, error } = await this.supabase.db.from('task_collaborators').select('task_owner_user_id,permission').eq('user_id', userId).eq('task_id', taskId).maybeSingle();
    if (error) throw new ServiceUnavailableException('Task access could not be checked. Please try again.');
    return data || null;
  }
  private async invitationByToken(token: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new NotFoundException('This invitation link is invalid or has expired.');
    const { data, error } = await this.supabase.db.from('task_invitations').select('*').eq('token_hash', this.hash(token)).maybeSingle();
    if (error) throw new ServiceUnavailableException('The invitation could not be checked. Please try again.');
    if (!data) throw new NotFoundException('This invitation link is invalid or has expired.');
    return data;
  }
  private async person(userId: string, permission: string) {
    const [{ data: auth }, { data: profile }] = await Promise.all([
      this.supabase.auth.admin.getUserById(userId),
      this.supabase.db.from('profiles').select('username,avatar_path').eq('id', userId).maybeSingle(),
    ]);
    const username = profile?.username || auth?.user?.user_metadata?.full_name || auth?.user?.user_metadata?.name || auth?.user?.email?.split('@')[0] || 'Collaborator';
    let avatarUrl = typeof auth?.user?.user_metadata?.avatar_url === 'string' ? auth.user.user_metadata.avatar_url : undefined;
    if (profile?.avatar_path) {
      const bucket = process.env.SUPABASE_PROFILE_BUCKET?.trim() || 'profile-pictures';
      const { data: signed } = await this.supabase.db.storage.from(bucket).createSignedUrl(profile.avatar_path, 300);
      if (signed?.signedUrl) avatarUrl = signed.signedUrl;
    }
    return { userId, username, avatarUrl, permission };
  }
  private async notifyTaskMembers(ownerId: string, taskId: string, actorId: string, type: string, title: string, message: string, eventKey: string) {
    const { data } = await this.supabase.db.from('task_collaborators').select('user_id').eq('task_owner_user_id', ownerId).eq('task_id', taskId);
    const recipientIds = new Set([ownerId, ...(data || []).map((row) => row.user_id)]);
    recipientIds.delete(actorId);
    for (const recipient of recipientIds) await this.notify(recipient, type, title, message, taskId, `${eventKey}:${recipient}`);
  }
  private async notify(recipientId: string, type: string, title: string, message: string, taskId: string, dedupeKey: string, invitationId?: string) {
    const { error } = await this.supabase.db.from('notifications').upsert({ recipient_user_id: recipientId, notification_type: type, title, message, related_task_id: taskId, related_collaboration_task_id: taskId, related_invitation_id: invitationId || null, related_scheduled_action_id: null, dedupe_key: dedupeKey }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
    if (error) this.logger.warn(`Could not create collaboration notification (${type}).`);
  }
  private requireVerifiedEmail(email: string, verified: boolean) {
    if (!email) throw new ForbiddenException('Your account needs an email address to use invitations.');
    if (!verified) throw new ForbiddenException('Verify your email address before accepting a task invitation.');
  }
  private cleanEmail(value: unknown) {
    if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new BadRequestException('Enter a valid email address.');
    return value.trim().toLowerCase();
  }
  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
}
