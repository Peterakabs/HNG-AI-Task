import { UnauthorizedException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/auth.service';
import { JsonStore, ScopeContext } from '../src/store';
import { ReminderService } from '../src/reminder.service';

describe('AuthService (unit)', () => {
  let directory: string;
  let auth: AuthService;
  let previousAuthFile: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'spectre-auth-'));
    previousAuthFile = process.env.SPECTRE_AUTH_FILE;
    process.env.SPECTRE_AUTH_FILE = join(directory, 'auth.json');
    auth = new AuthService(new JsonStore(new ScopeContext(), join(directory, 'tasks.json')));
  });
  afterEach(() => {
    if (previousAuthFile === undefined) delete process.env.SPECTRE_AUTH_FILE;
    else process.env.SPECTRE_AUTH_FILE = previousAuthFile;
    rmSync(directory, { recursive: true, force: true });
  });

  it('registers with a hashed password and authenticates using email/password', async () => {
    const registered = await auth.register({ email: 'Ada@Example.com', password: 'correct horse battery' }, 'device-1');
    expect(registered.user.email).toBe('ada@example.com');
    expect((auth as any).read().users[0].passwordHash).not.toContain('correct horse battery');
    expect(auth.login({ email: 'ADA@example.com', password: 'correct horse battery' }).user.id).toBe(registered.user.id);
    expect(() => auth.login({ email: 'ada@example.com', password: 'wrong password' })).toThrow(UnauthorizedException);
  });

  it('requires confirmation, scopes actions by creator, and deduplicates retries', async () => {
    const { user } = await auth.register({ email: 'owner@example.com', password: 'correct horse battery' }, 'device-2');
    const input = { clientRequestId: 'pending-reminder-1', recipientName: 'Michael', recipientEmail: 'michael@example.com', subject: 'Reminder: Design', message: 'complete the design', scheduledAt: new Date(Date.now() + 60_000).toISOString(), timezone: 'Africa/Lagos', confirmed: true };
    const first = auth.createAction(user.id, input);
    const replay = auth.createAction(user.id, input);
    expect(replay.id).toBe(first.id);
    expect(auth.listActions(user.id)).toHaveLength(1);
    expect(auth.listActions('another-user')).toHaveLength(0);
    expect(() => auth.createAction(user.id, { ...input, confirmed: false })).toThrow();
  });


  it('executes a due reminder once and records provider failure without retrying it', async () => {
    const { user } = await auth.register({ email: 'worker@example.com', password: 'correct horse battery' }, 'device-6');
    const action = auth.createAction(user.id, { recipientName: 'Michael', recipientEmail: 'michael@example.com', subject: 'Reminder', message: 'finish design', scheduledAt: new Date(Date.now() + 250).toISOString(), timezone: 'Africa/Lagos', confirmed: true });
    const deliver = jest.spyOn(auth, 'sendEmail').mockResolvedValue(undefined);
    const worker = new ReminderService(auth);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.runDue(); await worker.runDue();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(auth.listActions(user.id).find((item) => item.id === action.id)?.status).toBe('completed');
    const failedAction = auth.createAction(user.id, { recipientName: 'Jamie', recipientEmail: 'jamie@example.com', subject: 'Reminder', message: 'finish design', scheduledAt: new Date(Date.now() + 250).toISOString(), timezone: 'Africa/Lagos', confirmed: true });
    deliver.mockRejectedValueOnce(new Error('provider unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.runDue(); await worker.runDue();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(auth.listActions(user.id).find((item) => item.id === failedAction.id)).toEqual(expect.objectContaining({ status: 'failed', failureReason: 'provider unavailable' }));
  });
});
