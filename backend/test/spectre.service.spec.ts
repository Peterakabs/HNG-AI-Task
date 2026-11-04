import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SpectreService } from '../src/spectre.service';
import { ScopeContext, SpectreData } from '../src/store';

describe('SpectreService (unit)', () => {
  let service: SpectreService;
  let scopes: ScopeContext;
  let rows: Map<string, SpectreData>;
  let store: any;

  beforeEach(() => {
    scopes = new ScopeContext(); rows = new Map();
    store = {
      id: () => randomUUID(),
      read: async (scope = scopes.current()) => structuredClone(rows.get(scope) || { tasks: [], folders: ['Personal', 'Work'], tags: [], notes: [], username: 'User1234' }),
      write: async (data: SpectreData, scope = scopes.current()) => { rows.set(scope, structuredClone(data)); },
    };
    service = new SpectreService(store);
  });

  const validTask = (extra = {}) => ({ title: 'Write API tests', start: '2026-09-28', due: '2026-09-29T10:00', status: 'To Do', priority: 'High', tags: ['Engineering'], subtasks: [], attachments: [], ...extra });

  it('creates tasks, normalizes tags, and filters by tag and title', async () => {
    const task = await service.createTask(validTask({ tags: ['Engineering', 'Engineering', ''] }));
    expect(task.id).toBeTruthy(); expect(task.tags).toEqual(['Engineering']);
    expect(await service.listTasks({ tag: 'Engineering', title: 'API' })).toHaveLength(1);
    expect(await service.listTasks({ title: 'missing' })).toHaveLength(0);
  });

  it('makes voice-created personal reminders idempotent for the same draft ID', async () => {
    const assistantDraftId = randomUUID();
    const first = await service.createTask(validTask({ assistantDraftId, title: 'Submit report' }));
    const retry = await service.createTask(validTask({ assistantDraftId, title: 'Submit report' }));
    expect(retry.id).toBe(first.id);
    expect(await service.listTasks()).toHaveLength(1);
  });

  it('initializes persistent owner state and keeps each scope separate', async () => {
    const guest = `guest:${randomUUID()}`;
    const first = await scopes.run(guest, () => service.getProfile());
    await scopes.run(guest, () => service.updateProfile({ username: 'Ada' }));
    expect(await scopes.run(guest, () => service.getProfile())).toEqual({ username: 'Ada' });
    expect(await service.getProfile()).toEqual(first);
  });

  it('rejects invalid task status and missing required fields', async () => {
    await expect(service.createTask(validTask({ status: 'Blocked' }))).rejects.toThrow(BadRequestException);
    await expect(service.createTask(validTask({ title: ' ' }))).rejects.toThrow(BadRequestException);
  });

  it('creates the next recurring occurrence only on the first completion', async () => {
    const task = await service.createTask(validTask({ recurrence: 'Weekly', due: '2026-09-29T10:00' }));
    const first = await service.updateTask(task.id, { status: 'Completed' });
    expect(first.recurringTask?.due).toBe('2026-10-06T10:00'); expect(first.recurringTask?.status).toBe('To Do');
    const second = await service.updateTask(task.id, { status: 'Completed' });
    expect(second.recurringTask).toBeUndefined(); expect(await service.listTasks()).toHaveLength(2);
  });

  it('persists checklist completion metadata independently from parent task status', async () => {
    const task = await service.createTask(validTask({ subtasks: [{ text: 'Read chapter' }, { text: 'Write notes' }] }));
    const actor = randomUUID();
    const marked = await service.updateTask(task.id, { subtasks: task.subtasks.map((item, index) => index ? item : { ...item, done: true }) }, undefined, actor);
    expect(marked.task.status).toBe('To Do');
    expect(marked.task.subtasks[0]).toMatchObject({ done: true, is_completed: true, completed_by: actor });
    expect(marked.task.subtasks[0].completed_at).toEqual(expect.any(String));
    expect(marked.task.subtasks[1]).toMatchObject({ done: false, is_completed: false, completed_at: null, completed_by: null });

    const unchecked = await service.updateTask(task.id, { subtasks: marked.task.subtasks.map((item, index) => index ? item : { ...item, done: false }) }, undefined, actor);
    expect(unchecked.task.status).toBe('To Do');
    expect(unchecked.task.subtasks[0]).toMatchObject({ done: false, is_completed: false, completed_at: null, completed_by: null });
  });

  it('resets recurring checklist completion state on the next occurrence', async () => {
    const task = await service.createTask(validTask({ recurrence: 'Weekly', subtasks: [{ text: 'Prepare', done: true }] }));
    const completed = await service.updateTask(task.id, { status: 'Completed' });
    expect(completed.recurringTask?.subtasks[0]).toMatchObject({ done: false, is_completed: false, completed_at: null, completed_by: null });
  });

  it('reorders tasks and rejects duplicate ids', async () => {
    const first = await service.createTask(validTask({ title: 'First' }));
    const second = await service.createTask(validTask({ title: 'Second' }));
    expect((await service.reorderTasks([second.id, first.id])).map((task) => task.title)).toEqual(['Second', 'First']);
    await expect(service.reorderTasks([first.id, first.id])).rejects.toThrow(BadRequestException);
  });

  it('manages folders, tags, notes, and username', async () => {
    expect(await service.listFolders()).toContain('Personal');
    await service.createFolder('Home'); await expect(service.createFolder('Home')).rejects.toThrow(BadRequestException);
    await service.createTag('Focus'); expect(await service.listTags()).toContain('Focus');
    const note = await service.createNote({ title: 'Idea', text: 'Ship Spectre' });
    expect((await service.updateNote(note.id, { text: 'Ship React Spectre' })).text).toBe('Ship React Spectre');
    expect((await service.deleteNote(note.id)).id).toBe(note.id);
    expect(await service.updateProfile({ username: 'Ada' })).toEqual({ username: 'Ada' });
    expect(await service.getProfile()).toEqual({ username: 'Ada' });
  });
});
