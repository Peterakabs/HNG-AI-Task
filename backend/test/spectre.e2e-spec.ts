import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';

describe('Spectre API (integration)', () => {
  let app: INestApplication;
  let directory: string;
  let taskId: string;
  let recurringTaskId: string;
  let noteId: string;
  const deviceId = randomUUID();
  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string) => (request(app.getHttpServer()) as any)[method](path).set('x-device-id', deviceId);

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spectre-api-'));
    process.env.SPECTRE_DATA_FILE = join(directory, 'data.json');
    process.env.SPECTRE_AUTH_FILE = join(directory, 'auth.json');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); delete process.env.SPECTRE_DATA_FILE; delete process.env.SPECTRE_AUTH_FILE; });

  it('serves health and profile APIs', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200).expect({ status: 'ok', service: 'spectre-api' });
    const profile = await api('get', '/api/profile').expect(200);
    expect(profile.body.username).toMatch(/^User\d{4}$/);
    await api('put', '/api/profile').send({ username: 'Ada' }).expect(200, { username: 'Ada' });
  });

  it('creates and filters folders, tags, and tasks through HTTP', async () => {
    expect((await api('get', '/api/folders').expect(200)).body).toContain('Personal');
    await api('post', '/api/folders').send({ name: 'Research' }).expect(201, { name: 'Research' });
    await api('post', '/api/tags').send({ name: 'Urgent' }).expect(201, { name: 'Urgent' });
    expect((await api('get', '/api/tags').expect(200)).body).toContain('Urgent');
    const created = await api('post', '/api/tasks').send({
      title: 'Prepare demo', start: '2026-09-28', due: '2026-09-29T09:30',
      status: 'To Do', priority: 'High', folder: 'Research', tags: ['Urgent'],
      description: 'Demo API and React app', subtasks: [{ text: 'Slides', done: false }], attachments: [], recurrence: 'Weekly',
    }).expect(201);
    taskId = created.body.id;
    expect((await api('get', '/api/tasks?folder=Research&tag=Urgent&title=demo').expect(200)).body).toHaveLength(1);
    expect((await api('get', `/api/tasks/${taskId}`).expect(200)).body.title).toBe('Prepare demo');
    const updated = await api('patch', `/api/tasks/${taskId}`).send({ status: 'In Progress' }).expect(200);
    expect(updated.body.task.status).toBe('In Progress');
    await api('put', '/api/tasks/reorder').send({ ids: [taskId] }).expect(200);
    await api('delete', '/api/folders/Research').expect(200);
    expect((await api('get', `/api/tasks/${taskId}`).expect(200)).body.folder).toBe('');
    const completed = await api('patch', `/api/tasks/${taskId}`).send({ status: 'Completed' }).expect(200);
    recurringTaskId = completed.body.recurringTask.id;
    expect(completed.body.recurringTask.status).toBe('To Do');
  });

  it('creates, updates, deletes notes and deletes tasks', async () => {
    const created = await api('post', '/api/notes').send({ title: 'Idea', text: 'Ship the app' }).expect(201);
    noteId = created.body.id;
    await api('patch', `/api/notes/${noteId}`).send({ text: 'Ship the React app' }).expect(200);
    expect((await api('get', '/api/notes').expect(200)).body[0].text).toBe('Ship the React app');
    await api('delete', `/api/notes/${noteId}`).expect(200);
    await api('delete', `/api/tasks/${taskId}`).expect(200);
    await api('delete', `/api/tasks/${recurringTaskId}`).expect(200);
    await api('get', `/api/tasks/${taskId}`).expect(404);
  });


  it('supports email/password signup, guest data migration, owner-scoped scheduled actions, and invitations', async () => {
    const guestDevice = randomUUID();
    await request(app.getHttpServer()).post('/api/tasks').set('x-device-id', guestDevice).send({ title: 'Guest task', start: '2026-09-28', due: '2026-09-29T09:30', status: 'To Do', priority: 'Medium' }).expect(201);
    const guest = request.agent(app.getHttpServer());
    const signup = await guest.post('/api/auth/signup').set('x-device-id', guestDevice).send({ email: 'creator@example.com', password: 'correct horse battery' }).expect(201);
    expect(signup.body).toEqual(expect.objectContaining({ email: 'creator@example.com' }));
    expect(signup.body.passwordHash).toBeUndefined();
    expect((await guest.get('/api/tasks').set('x-device-id', guestDevice).expect(200)).body).toHaveLength(1);
    await request(app.getHttpServer()).post('/api/scheduled-actions').set('x-device-id', guestDevice).send({}).expect(401);
    const reminder = { clientRequestId: 'same-action', recipientName: 'Michael', recipientEmail: 'michael@example.com', subject: 'Reminder: Design', message: 'complete the design', scheduledAt: '2027-01-01T16:00:00.000Z', timezone: 'Africa/Lagos', confirmed: true };
    const scheduled = await guest.post('/api/scheduled-actions').set('x-device-id', guestDevice).send(reminder).expect(201);
    expect(scheduled.body.status).toBe('scheduled');
    expect((await guest.get(`/api/scheduled-actions/${scheduled.body.id}`).set('x-device-id', guestDevice).expect(200)).body.id).toBe(scheduled.body.id);
    const replay = await guest.post('/api/scheduled-actions').set('x-device-id', guestDevice).send(reminder).expect(201);
    expect(replay.body.id).toBe(scheduled.body.id);
    expect((await guest.get('/api/scheduled-actions').set('x-device-id', guestDevice).expect(200)).body).toHaveLength(1);
    const invitation = await guest.post('/api/invitations').set('x-device-id', guestDevice).send({ recipientName: 'Michael', recipientEmail: 'michael@example.com' }).expect(201);
    expect(invitation.body).toEqual(expect.objectContaining({ status: 'pending', emailStatus: 'failed' }));
    expect(invitation.body.token).toBeUndefined();
    expect(invitation.body.senderUserId).toBeUndefined();
    const token = new URL(invitation.body.invitationUrl).searchParams.get('invite');
    expect((await request(app.getHttpServer()).get(`/api/auth/invitations/${token}`).set('x-device-id', randomUUID()).expect(200)).body.senderUserId).toBeUndefined();
    const invited = request.agent(app.getHttpServer()); const invitedDevice = randomUUID();
    await invited.post('/api/auth/signup').set('x-device-id', invitedDevice).send({ email: 'michael@example.com', password: 'invited account password', invitationToken: token }).expect(201);
    expect((await invited.get('/api/auth/me').set('x-device-id', invitedDevice).expect(200)).body.email).toBe('michael@example.com');
    expect((await invited.get('/api/scheduled-actions').set('x-device-id', invitedDevice).expect(200)).body).toEqual([]);
    expect((await request(app.getHttpServer()).get(`/api/auth/invitations/${token}`).set('x-device-id', randomUUID()).expect(200)).body.status).toBe('accepted');
    const invitations = await guest.get('/api/invitations').set('x-device-id', guestDevice).expect(200);
    expect(invitations.body[0].senderUserId).toBeUndefined();
    const secondInvitation = await guest.post('/api/invitations').set('x-device-id', guestDevice).send({ recipientName: 'Jamie', recipientEmail: 'jamie@example.com' }).expect(201);
    await guest.delete(`/api/invitations/${secondInvitation.body.id}`).set('x-device-id', guestDevice).expect(200);
    await guest.post('/api/auth/logout').set('x-device-id', guestDevice).expect(201);
    await guest.get('/api/scheduled-actions').set('x-device-id', guestDevice).expect(401);
    await guest.post('/api/auth/login').set('x-device-id', guestDevice).send({ email: 'creator@example.com', password: 'correct horse battery' }).expect(201);
    expect((await guest.get('/api/scheduled-actions').set('x-device-id', guestDevice).expect(200)).body).toHaveLength(1);
    await guest.post('/api/auth/logout').set('x-device-id', guestDevice).expect(201);
  });

  it('returns useful validation errors for invalid API input', async () => {
    await api('post', '/api/tasks').send({ title: '' }).expect(400);
    await api('post', '/api/notes').send({ text: '' }).expect(400);
    await api('post', '/api/folders').send({ name: '   ' }).expect(400);
    await api('post', '/api/tags').send({ name: '' }).expect(400);
  });
});
