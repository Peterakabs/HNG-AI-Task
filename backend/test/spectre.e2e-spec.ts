import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Spectre API (integration)', () => {
  let app: INestApplication;
  let directory: string;
  let taskId: string;
  let recurringTaskId: string;
  let noteId: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spectre-api-'));
    process.env.SPECTRE_DATA_FILE = join(directory, 'data.json');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); delete process.env.SPECTRE_DATA_FILE; });

  it('serves health and profile APIs', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200).expect({ status: 'ok', service: 'spectre-api' });
    const profile = await request(app.getHttpServer()).get('/api/profile').expect(200);
    expect(profile.body.username).toMatch(/^User\d{4}$/);
    await request(app.getHttpServer()).put('/api/profile').send({ username: 'Ada' }).expect(200, { username: 'Ada' });
  });

  it('creates and filters folders, tags, and tasks through HTTP', async () => {
    expect((await request(app.getHttpServer()).get('/api/folders').expect(200)).body).toContain('Personal');
    await request(app.getHttpServer()).post('/api/folders').send({ name: 'Research' }).expect(201, { name: 'Research' });
    await request(app.getHttpServer()).post('/api/tags').send({ name: 'Urgent' }).expect(201, { name: 'Urgent' });
    expect((await request(app.getHttpServer()).get('/api/tags').expect(200)).body).toContain('Urgent');
    const created = await request(app.getHttpServer()).post('/api/tasks').send({
      title: 'Prepare demo', start: '2026-09-28', due: '2026-09-29T09:30',
      status: 'To Do', priority: 'High', folder: 'Research', tags: ['Urgent'],
      description: 'Demo API and React app', subtasks: [{ text: 'Slides', done: false }], attachments: [], recurrence: 'Weekly',
    }).expect(201);
    taskId = created.body.id;
    expect((await request(app.getHttpServer()).get('/api/tasks?folder=Research&tag=Urgent&title=demo').expect(200)).body).toHaveLength(1);
    expect((await request(app.getHttpServer()).get(`/api/tasks/${taskId}`).expect(200)).body.title).toBe('Prepare demo');
    const updated = await request(app.getHttpServer()).patch(`/api/tasks/${taskId}`).send({ status: 'In Progress' }).expect(200);
    expect(updated.body.task.status).toBe('In Progress');
    await request(app.getHttpServer()).put('/api/tasks/reorder').send({ ids: [taskId] }).expect(200);
    await request(app.getHttpServer()).delete('/api/folders/Research').expect(200);
    expect((await request(app.getHttpServer()).get(`/api/tasks/${taskId}`).expect(200)).body.folder).toBe('');
    const completed = await request(app.getHttpServer()).patch(`/api/tasks/${taskId}`).send({ status: 'Completed' }).expect(200);
    recurringTaskId = completed.body.recurringTask.id;
    expect(completed.body.recurringTask.status).toBe('To Do');
  });

  it('creates, updates, deletes notes and deletes tasks', async () => {
    const created = await request(app.getHttpServer()).post('/api/notes').send({ title: 'Idea', text: 'Ship the app' }).expect(201);
    noteId = created.body.id;
    await request(app.getHttpServer()).patch(`/api/notes/${noteId}`).send({ text: 'Ship the React app' }).expect(200);
    expect((await request(app.getHttpServer()).get('/api/notes').expect(200)).body[0].text).toBe('Ship the React app');
    await request(app.getHttpServer()).delete(`/api/notes/${noteId}`).expect(200);
    await request(app.getHttpServer()).delete(`/api/tasks/${taskId}`).expect(200);
    await request(app.getHttpServer()).delete(`/api/tasks/${recurringTaskId}`).expect(200);
    await request(app.getHttpServer()).get(`/api/tasks/${taskId}`).expect(404);
  });

  it('returns useful validation errors for invalid API input', async () => {
    await request(app.getHttpServer()).post('/api/tasks').send({ title: '' }).expect(400);
    await request(app.getHttpServer()).post('/api/notes').send({ text: '' }).expect(400);
    await request(app.getHttpServer()).post('/api/folders').send({ name: '   ' }).expect(400);
    await request(app.getHttpServer()).post('/api/tags').send({ name: '' }).expect(400);
  });
});
