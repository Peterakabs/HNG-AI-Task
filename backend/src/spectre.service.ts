import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JsonStore, SpectreData } from './store';

const priorities = ['High', 'Medium', 'Low'];
const statuses = ['To Do', 'In Progress', 'Completed'];

@Injectable()
export class SpectreService {
  constructor(private readonly store: JsonStore) {}

  listTasks(query: Record<string, string | undefined> = {}) {
    const data = this.store.read();
    let tasks = [...data.tasks];
    if (query.status) tasks = tasks.filter((task) => task.status === query.status);
    if (query.priority) tasks = tasks.filter((task) => task.priority === query.priority);
    if (query.tag) tasks = tasks.filter((task) => task.tags?.includes(query.tag));
    if (query.folder) tasks = tasks.filter((task) => task.folder === query.folder);
    if (query.title) tasks = tasks.filter((task) => task.title.toLowerCase().includes(query.title!.toLowerCase()));
    if (query.date) tasks = tasks.filter((task) => task.due?.slice(0, 10) === query.date);
    if (query.sort === 'due') tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    if (query.sort === 'priority') tasks.sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority));
    if (query.sort === 'created') tasks.sort((a, b) => b.createdAt - a.createdAt);
    if (query.sort === 'alpha') tasks.sort((a, b) => a.title.localeCompare(b.title));
    if (!query.sort || query.sort === 'manual') tasks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return tasks;
  }

  createTask(input: Record<string, any>) {
    this.validateTask(input, true);
    const data = this.store.read();
    const task = {
      id: this.store.id(), title: input.title.trim(), description: input.description?.trim() || '',
      start: input.start, due: input.due, status: input.status, priority: input.priority,
      emailReminder: Boolean(input.emailReminder),
      folder: input.folder || '', tags: this.cleanTags(input.tags), subtasks: input.subtasks || [],
      attachments: input.attachments || [], notes: input.notes?.trim() || '',
      recurrence: input.recurrence || '', reminder: input.reminder || '', notified: false,
      createdAt: Date.now(), order: data.tasks.length,
    };
    data.tasks.push(task);
    this.recordTags(data, task.tags);
    this.store.write(data);
    return task;
  }

  getTask(id: string) { return this.requireTask(this.store.read(), id); }

  updateTask(id: string, input: Record<string, any>) {
    const data = this.store.read();
    const task = this.requireTask(data, id);
    const wasCompleted = task.status === 'Completed';
    const merged = { ...task, ...input };
    this.validateTask(merged, true);
    Object.assign(task, merged, {
      title: merged.title.trim(), description: merged.description?.trim() || '',
      tags: this.cleanTags(merged.tags), notified: merged.due === task.due ? task.notified : false,
    });
    this.recordTags(data, task.tags);
    let recurringTask: Record<string, any> | undefined;
    if (input.status === 'Completed' && task.recurrence && !wasCompleted) {
      recurringTask = this.nextOccurrence(task, data.tasks.length);
      if (recurringTask) data.tasks.push(recurringTask);
    }
    this.store.write(data);
    return { task, recurringTask };
  }

  deleteTask(id: string) {
    const data = this.store.read();
    const task = this.requireTask(data, id);
    data.tasks = data.tasks.filter((item) => item.id !== id);
    this.store.write(data);
    return task;
  }

  reorderTasks(ids: string[]) {
    const data = this.store.read();
    if (!Array.isArray(ids) || ids.length !== data.tasks.length || new Set(ids).size !== ids.length || ids.some((id) => !data.tasks.some((task) => task.id === id))) {
      throw new BadRequestException('Order must contain every task id exactly once.');
    }
    const byId = new Map(data.tasks.map((task) => [task.id, task]));
    ids.forEach((id, order) => { byId.get(id)!.order = order; });
    data.tasks.sort((a, b) => a.order - b.order);
    this.store.write(data);
    return data.tasks;
  }

  listFolders() { return this.store.read().folders; }
  createFolder(name: string) {
    const clean = this.requireName(name, 'Folder');
    const data = this.store.read();
    if (data.folders.some((folder) => folder.toLowerCase() === clean.toLowerCase())) throw new BadRequestException('Folder already exists.');
    data.folders.push(clean); this.store.write(data); return { name: clean };
  }
  deleteFolder(name: string) {
    const data = this.store.read();
    if (!data.folders.includes(name)) throw new NotFoundException('Folder not found.');
    data.folders = data.folders.filter((folder) => folder !== name);
    data.tasks.forEach((task) => { if (task.folder === name) task.folder = ''; });
    this.store.write(data); return { name };
  }

  listTags() { return this.store.read().tags; }
  createTag(name: string) {
    const clean = this.requireName(name, 'Tag');
    const data = this.store.read();
    if (data.tags.some((tag) => tag.toLowerCase() === clean.toLowerCase())) throw new BadRequestException('Tag already exists.');
    data.tags.push(clean); this.store.write(data); return { name: clean };
  }

  listNotes() { return this.store.read().notes.sort((a, b) => b.createdAt - a.createdAt); }
  createNote(input: Record<string, any>) {
    if (typeof input.text !== 'string' || !input.text.trim()) throw new BadRequestException('Note text is required.');
    const data = this.store.read();
    const note = { id: this.store.id(), title: String(input.title || '').trim(), text: input.text.trim(), createdAt: Date.now() };
    data.notes.push(note); this.store.write(data); return note;
  }
  updateNote(id: string, input: Record<string, any>) {
    const data = this.store.read(); const note = data.notes.find((item) => item.id === id);
    if (!note) throw new NotFoundException('Note not found.');
    if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim())) throw new BadRequestException('Note text cannot be empty.');
    if (input.title !== undefined) note.title = String(input.title).trim();
    if (input.text !== undefined) note.text = input.text.trim();
    this.store.write(data); return note;
  }
  deleteNote(id: string) {
    const data = this.store.read(); const note = data.notes.find((item) => item.id === id);
    if (!note) throw new NotFoundException('Note not found.');
    data.notes = data.notes.filter((item) => item.id !== id); this.store.write(data); return note;
  }

  getProfile() { const { username } = this.store.read(); return { username }; }
  updateProfile(input: Record<string, any>) {
    const username = this.requireName(input.username, 'Username');
    const data = this.store.read(); data.username = username; this.store.write(data); return { username };
  }

  private requireTask(data: SpectreData, id: string) {
    const task = data.tasks.find((item) => item.id === id);
    if (!task) throw new NotFoundException('Task not found.');
    return task;
  }
  private requireName(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${label} name is required.`);
    return value.trim().slice(0, 80);
  }
  private cleanTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))];
  }
  private recordTags(data: SpectreData, tags: string[]) {
    tags.forEach((tag) => { if (!data.tags.some((known) => known.toLowerCase() === tag.toLowerCase())) data.tags.push(tag); });
  }
  private validateTask(task: Record<string, any>, required: boolean) {
    if (required && (typeof task.title !== 'string' || !task.title.trim())) throw new BadRequestException('Task title is required.');
    if (!statuses.includes(task.status)) throw new BadRequestException('Status must be To Do, In Progress, or Completed.');
    if (!priorities.includes(task.priority)) throw new BadRequestException('Priority must be High, Medium, or Low.');
    if (typeof task.start !== 'string' || !task.start || Number.isNaN(Date.parse(task.start))) throw new BadRequestException('A valid start date is required.');
    if (typeof task.due !== 'string' || !task.due || Number.isNaN(Date.parse(task.due))) throw new BadRequestException('A valid due date and time is required.');
    if (!Array.isArray(task.subtasks || []) || !Array.isArray(task.attachments || []) || !Array.isArray(task.tags || [])) throw new BadRequestException('Tags, subtasks, and attachments must be arrays.');
  }
  private nextOccurrence(task: Record<string, any>, order: number) {
    const date = new Date(task.due);
    if (task.recurrence === 'Daily') date.setDate(date.getDate() + 1);
    else if (task.recurrence === 'Weekly') date.setDate(date.getDate() + 7);
    else if (task.recurrence === 'Monthly') date.setMonth(date.getMonth() + 1);
    else return undefined;
    const pad = (n: number) => String(n).padStart(2, '0');
    const due = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return { ...task, id: this.store.id(), due, status: 'To Do', createdAt: Date.now(), notified: false, order, subtasks: task.subtasks.map((item: any) => ({ ...item, done: false })) };
  }
}
