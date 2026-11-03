import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseStore, SpectreData } from './store';

const priorities = ['High', 'Medium', 'Low'];
const statuses = ['To Do', 'Pending', 'Acknowledged', 'In Progress', 'Completed'];

@Injectable()
export class SpectreService {
  constructor(private readonly store: SupabaseStore) {}

  async listWeeklySummaries(timezone = 'Africa/Lagos') {
    const zone = this.safeTimeZone(timezone);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const data = await this.store.read();
      const summaries = data.weeklySummaries ?? (data.weeklySummaries = []);
      let changed = false;
      const now = new Date();
      const currentWeek = this.weekStartKey(now, zone);
      const previousWeek = this.shiftDateKey(currentWeek, -7);

      // Give completed tasks created before this feature a full current week before archiving.
      for (const task of data.tasks) {
        if (task.status === 'Completed' && !task.completedAt) {
          task.completedAt = now.toISOString();
          changed = true;
        }
      }

      const archiveByWeek = new Map<string, Record<string, any>[]>();
      const archivedIds = new Set<string>();
      for (const task of data.tasks) {
        if (task.status !== 'Completed' || !task.completedAt) continue;
        const weekStart = this.weekStartKey(new Date(task.completedAt), zone);
        if (weekStart >= currentWeek) continue;
        if (!archiveByWeek.has(weekStart)) archiveByWeek.set(weekStart, []);
        archiveByWeek.get(weekStart)!.push({ ...task });
        archivedIds.add(task.id);
      }

      const ensureSummary = (weekStart: string) => {
        let summary = summaries.find((item) => item.weekStart === weekStart);
        if (!summary) {
          summary = { id: this.store.id(), weekStart, weekEnd: this.shiftDateKey(weekStart, 6), tasks: [], createdAt: now.toISOString(), viewedAt: null };
          summaries.push(summary);
          changed = true;
        }
        summary.tasks ??= [];
        return summary;
      };

      for (const [weekStart, tasks] of archiveByWeek) {
        const summary = ensureSummary(weekStart);
        const existingIds = new Set(summary.tasks.map((task: Record<string, any>) => task.id));
        for (const task of tasks) {
          if (!existingIds.has(task.id)) {
            summary.tasks.push(task);
            changed = true;
          }
        }
      }

      // Create a report for every elapsed week, even when nothing was completed.
      if (data.weeklySummaryThrough) {
        let cursor = this.shiftDateKey(data.weeklySummaryThrough, 7);
        while (cursor <= previousWeek) {
          ensureSummary(cursor);
          cursor = this.shiftDateKey(cursor, 7);
        }
      } else {
        ensureSummary(previousWeek);
        changed = true;
      }
      if (data.weeklySummaryThrough !== previousWeek) {
        data.weeklySummaryThrough = previousWeek;
        changed = true;
      }
      if (archivedIds.size) {
        data.tasks = data.tasks.filter((task) => !archivedIds.has(task.id));
        changed = true;
      }

      if (changed) {
        try { await this.store.write(data); }
        catch (error) { if (error instanceof ConflictException && attempt < 2) continue; throw error; }
      }
      return summaries.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    }
    throw new ConflictException('Weekly summaries changed in another request. Please retry.');
  }

  async markWeeklySummaryViewed(id: string) {
    const data = await this.store.read();
    const summaries = data.weeklySummaries ?? (data.weeklySummaries = []);
    const summary = summaries.find((item) => item.id === id);
    if (!summary) throw new NotFoundException('Weekly summary not found.');
    if (!summary.viewedAt) {
      summary.viewedAt = new Date().toISOString();
      await this.store.write(data);
    }
    return summary;
  }

  async listTasks(query: Record<string, string | undefined> = {}) {
    const data = await this.store.read();
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

  async createTask(input: Record<string, any>) {
    this.validateTask(input, true);
    const data = await this.store.read();
    const assistantDraftId = typeof input.assistantDraftId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.assistantDraftId) ? input.assistantDraftId : undefined;
    if (assistantDraftId) {
      const prior = data.tasks.find((task) => task.assistantDraftId === assistantDraftId);
      if (prior) return prior;
    }
    const task = {
      id: this.store.id(), title: input.title.trim(), description: input.description?.trim() || '',
      start: input.start, due: input.due, status: input.status, priority: input.priority,
      emailReminder: Boolean(input.emailReminder),
      folder: input.folder || '', tags: this.cleanTags(input.tags), subtasks: input.subtasks || [],
      attachments: input.attachments || [], notes: input.notes?.trim() || '',
      recurrence: input.recurrence || '', recurrenceId: input.recurrence ? this.store.id() : undefined, reminder: input.reminder || '', notified: false,
      createdAt: Date.now(), order: data.tasks.length, ...(input.status === 'Completed' ? { completedAt: new Date().toISOString() } : {}), ...(assistantDraftId ? { assistantDraftId } : {}),
    };
    data.tasks.push(task);
    this.recordTags(data, task.tags);
    await this.store.write(data);
    return task;
  }

  async getTask(id: string) { return this.requireTask(await this.store.read(), id); }

  async updateTask(id: string, input: Record<string, any>) {
    const data = await this.store.read();
    const task = this.requireTask(data, id);
    const wasCompleted = task.status === 'Completed';
    const merged = { ...task, ...input };
    this.validateTask(merged, true);
    Object.assign(task, merged, {
      title: merged.title.trim(), description: merged.description?.trim() || '',
      tags: this.cleanTags(merged.tags), notified: merged.due === task.due ? task.notified : false,
    });
    if (input.status === 'Completed' && !wasCompleted) task.completedAt = new Date().toISOString();
    if (input.status && input.status !== 'Completed') delete task.completedAt;
    this.recordTags(data, task.tags);
    let recurringTask: Record<string, any> | undefined;
    if (input.status === 'Completed' && task.recurrence && !wasCompleted) {
      task.recurrenceId ||= task.id;
      // A completed occurrence can be reopened and completed again. Keep the
      // occurrence-to-next-occurrence relationship idempotent across taps.
      const priorNext = data.tasks.find((item) => item.previousOccurrenceId === task.id);
      if (!priorNext) {
        recurringTask = this.nextOccurrence(task, data.tasks.length);
        if (recurringTask) data.tasks.push(recurringTask);
      }
    }
    await this.store.write(data);
    return { task, recurringTask };
  }

  async deleteTask(id: string, allOccurrences = false) {
    const data = await this.store.read();
    const task = this.requireTask(data, id);
    const seriesId = task.recurrenceId;
    const deletedCount = allOccurrences && seriesId ? data.tasks.filter((item) => item.recurrenceId === seriesId).length : 1;
    data.tasks = data.tasks.filter((item) => allOccurrences && seriesId ? item.recurrenceId !== seriesId : item.id !== id);
    await this.store.write(data);
    return { ...task, deletedCount };
  }

  async reorderTasks(ids: string[]) {
    const data = await this.store.read();
    if (!Array.isArray(ids) || ids.length !== data.tasks.length || new Set(ids).size !== ids.length || ids.some((id) => !data.tasks.some((task) => task.id === id))) {
      throw new BadRequestException('Order must contain every task id exactly once.');
    }
    const byId = new Map(data.tasks.map((task) => [task.id, task]));
    ids.forEach((id, order) => { byId.get(id)!.order = order; });
    data.tasks.sort((a, b) => a.order - b.order);
    await this.store.write(data);
    return data.tasks;
  }

  async listFolders() { return (await this.store.read()).folders; }
  async createFolder(name: string) {
    const clean = this.requireName(name, 'Folder');
    const data = await this.store.read();
    if (data.folders.some((folder) => folder.toLowerCase() === clean.toLowerCase())) throw new BadRequestException('Folder already exists.');
    data.folders.push(clean); await this.store.write(data); return { name: clean };
  }
  async deleteFolder(name: string) {
    const data = await this.store.read();
    if (!data.folders.includes(name)) throw new NotFoundException('Folder not found.');
    data.folders = data.folders.filter((folder) => folder !== name);
    data.tasks.forEach((task) => { if (task.folder === name) task.folder = ''; });
    await this.store.write(data); return { name };
  }

  async listTags() { return (await this.store.read()).tags; }
  async createTag(name: string) {
    const clean = this.requireName(name, 'Tag');
    const data = await this.store.read();
    if (data.tags.some((tag) => tag.toLowerCase() === clean.toLowerCase())) throw new BadRequestException('Tag already exists.');
    data.tags.push(clean); await this.store.write(data); return { name: clean };
  }

  async listNotes() { return (await this.store.read()).notes.sort((a, b) => b.createdAt - a.createdAt); }
  async createNote(input: Record<string, any>) {
    if (typeof input.text !== 'string' || !input.text.trim()) throw new BadRequestException('Note text is required.');
    const data = await this.store.read();
    const note = { id: this.store.id(), title: String(input.title || '').trim(), text: input.text.trim(), createdAt: Date.now() };
    data.notes.push(note); await this.store.write(data); return note;
  }
  async updateNote(id: string, input: Record<string, any>) {
    const data = await this.store.read(); const note = data.notes.find((item) => item.id === id);
    if (!note) throw new NotFoundException('Note not found.');
    if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim())) throw new BadRequestException('Note text cannot be empty.');
    if (input.title !== undefined) note.title = String(input.title).trim();
    if (input.text !== undefined) note.text = input.text.trim();
    await this.store.write(data); return note;
  }
  async deleteNote(id: string) {
    const data = await this.store.read(); const note = data.notes.find((item) => item.id === id);
    if (!note) throw new NotFoundException('Note not found.');
    data.notes = data.notes.filter((item) => item.id !== id); await this.store.write(data); return note;
  }

  async getProfile() { const data = await this.store.read(); return { username: data.username, ...(data.phone ? { phone: data.phone } : {}), ...(data.avatarUrl ? { avatarUrl: data.avatarUrl } : {}) }; }
  async updateProfile(input: Record<string, any>) {
    const username = this.requireName(input.username, 'Username');
    const phone = typeof input.phone === 'string' ? input.phone.trim().slice(0, 40) : undefined;
    const avatarUrl = typeof input.avatarUrl === 'string' ? input.avatarUrl.trim().slice(0, 800_000) : undefined;
    if (avatarUrl && !/^https:\/\//i.test(avatarUrl) && !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatarUrl)) throw new BadRequestException('Choose a valid HTTPS image or upload a JPG, PNG, or WebP image.');
    const data = await this.store.read(); data.username = username; if (phone !== undefined) data.phone = phone; if (avatarUrl !== undefined) data.avatarUrl = avatarUrl; await this.store.write(data); return { username, ...(data.phone ? { phone: data.phone } : {}), ...(data.avatarUrl ? { avatarUrl: data.avatarUrl } : {}) };
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

  private safeTimeZone(timezone: string) {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); return timezone; }
    catch { return 'Africa/Lagos'; }
  }
  private weekStartKey(value: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
    const part = (type: string) => parts.find((item) => item.type === type)?.value || '0';
    const localDate = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day'))));
    localDate.setUTCDate(localDate.getUTCDate() - ((localDate.getUTCDay() + 6) % 7));
    return localDate.toISOString().slice(0, 10);
  }
  private shiftDateKey(value: string, days: number) {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  private recordTags(data: SpectreData, tags: string[]) {
    tags.forEach((tag) => { if (!data.tags.some((known) => known.toLowerCase() === tag.toLowerCase())) data.tags.push(tag); });
  }
  private validateTask(task: Record<string, any>, required: boolean) {
    if (required && (typeof task.title !== 'string' || !task.title.trim())) throw new BadRequestException('Task title is required.');
    if (!statuses.includes(task.status)) throw new BadRequestException('Status must be To Do, Pending, Acknowledged, In Progress, or Completed.');
    if (['Pending', 'Acknowledged'].includes(task.status) && !task.emailReminder) throw new BadRequestException('Pending and Acknowledged are only valid for tasks with an external email reminder.');
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
    return { ...task, id: this.store.id(), recurrenceId: task.recurrenceId || task.id, previousOccurrenceId: task.id, due, status: 'To Do', completedAt: undefined, createdAt: Date.now(), notified: false, order, subtasks: task.subtasks.map((item: any) => ({ ...item, done: false })) };
  }
}
