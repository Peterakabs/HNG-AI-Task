import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/store';
import { SpectreService } from '../src/spectre.service';

describe('SpectreService (unit)', () => {
  let directory: string;
  let service: SpectreService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'spectre-unit-'));
    service = new SpectreService(new JsonStore(join(directory, 'data.json')));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const validTask = (extra = {}) => ({
    title: 'Write API tests', start: '2026-09-28', due: '2026-09-29T10:00',
    status: 'To Do', priority: 'High', tags: ['Engineering'], subtasks: [], attachments: [], ...extra,
  });

  it('creates tasks, normalizes tags, and filters by tag and title', () => {
    const task = service.createTask(validTask({ tags: ['Engineering', 'Engineering', ''] }));
    expect(task.id).toBeTruthy();
    expect(task.tags).toEqual(['Engineering']);
    expect(service.listTasks({ tag: 'Engineering', title: 'API' })).toHaveLength(1);
    expect(service.listTasks({ title: 'missing' })).toHaveLength(0);
  });

  it('rejects invalid task status and missing required fields', () => {
    expect(() => service.createTask(validTask({ status: 'Blocked' }))).toThrow(BadRequestException);
    expect(() => service.createTask(validTask({ title: ' ' }))).toThrow(BadRequestException);
  });

  it('creates the next recurring occurrence only on the first completion', () => {
    const task = service.createTask(validTask({ recurrence: 'Weekly', due: '2026-09-29T10:00' }));
    const first = service.updateTask(task.id, { status: 'Completed' });
    expect(first.recurringTask?.due).toBe('2026-10-06T10:00');
    expect(first.recurringTask?.status).toBe('To Do');
    const second = service.updateTask(task.id, { status: 'Completed' });
    expect(second.recurringTask).toBeUndefined();
    expect(service.listTasks()).toHaveLength(2);
  });

  it('reorders tasks and rejects duplicate ids', () => {
    const first = service.createTask(validTask({ title: 'First' }));
    const second = service.createTask(validTask({ title: 'Second' }));
    expect(service.reorderTasks([second.id, first.id]).map((task) => task.title)).toEqual(['Second', 'First']);
    expect(() => service.reorderTasks([first.id, first.id])).toThrow(BadRequestException);
  });

  it('manages folders, tags, notes, and username', () => {
    expect(service.listFolders()).toContain('Personal');
    service.createFolder('Home');
    expect(() => service.createFolder('Home')).toThrow(BadRequestException);
    service.createTag('Focus');
    expect(service.listTags()).toContain('Focus');
    const note = service.createNote({ title: 'Idea', text: 'Ship Spectre' });
    expect(service.updateNote(note.id, { text: 'Ship React Spectre' }).text).toBe('Ship React Spectre');
    expect(service.deleteNote(note.id).id).toBe(note.id);
    expect(service.updateProfile({ username: 'Ada' })).toEqual({ username: 'Ada' });
    expect(service.getProfile()).toEqual({ username: 'Ada' });
  });
});
