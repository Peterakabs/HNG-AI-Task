import { BadRequestException } from '@nestjs/common';
import { AuthService } from '../src/auth.service';
import { ReminderService } from '../src/reminder.service';
import { SpectreData } from '../src/store';
import { createHash } from 'node:crypto';

describe('AuthService (Supabase integration boundary)', () => {
  let auth: AuthService;
  let supabase: any;
  let store: any;
  let rows: Map<string, SpectreData>;

  beforeEach(() => {
    rows = new Map();
    store = {
      read: jest.fn(async (scope: string) => structuredClone(rows.get(scope) || { tasks: [], folders: [], tags: [], notes: [], username: 'User1234' })),
      write: jest.fn(async (data: SpectreData, scope: string) => { rows.set(scope, structuredClone(data)); }),
    };
    supabase = {
      auth: {
        admin: {
          createUser: jest.fn(async ({ email }: { email: string }) => ({ data: { user: { id: 'user-1', email, created_at: '2026-01-01T00:00:00Z' } }, error: null })),
          getUserById: jest.fn(async (id: string) => ({ data: { user: { id, email: 'ada@example.com' } }, error: null })),
          updateUserById: jest.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
          signOut: jest.fn(async () => ({ error: null })),
        },
        resetPasswordForEmail: jest.fn(async () => ({ error: null })),
        getUser: jest.fn(async (token: string) => token === 'valid-access' ? ({ data: { user: { id: 'user-1', email: 'ada@example.com' } }, error: null }) : ({ data: { user: null }, error: new Error('bad token') })),
      },
      newClient: jest.fn(() => ({ auth: { signInWithPassword: jest.fn(async ({ email }: { email: string }) => ({ data: { user: { id: 'user-1', email }, session: { access_token: 'valid-access', refresh_token: 'refresh-1' } }, error: null })) } })),
      db: {},
    };
    auth = new AuthService(supabase, store, { available: false, publicKey: '', send: jest.fn() } as any);
  });

  it('creates Supabase Auth accounts and returns a non-sensitive user and session cookie value', async () => {
    const result = await auth.register({ email: 'Ada@Example.com', password: 'correct horse battery' });
    expect(supabase.auth.admin.createUser).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse battery', email_confirm: true });
    expect(result.user).toEqual(expect.objectContaining({ id: 'user-1', email: 'ada@example.com' }));
    expect(JSON.parse(Buffer.from(result.session, 'base64url').toString())).toEqual({ access_token: 'valid-access', refresh_token: 'refresh-1' });
    await expect(auth.register({ email: 'bad', password: 'x' })).rejects.toThrow(BadRequestException);
    supabase.auth.admin.createUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('User already registered') });
    await expect(auth.register({ email: 'ada@example.com', password: 'another secure password' })).rejects.toThrow('An account with this email already exists.');
    supabase.newClient.mockReturnValueOnce({ auth: { signInWithPassword: jest.fn(async () => ({ data: { user: null, session: null }, error: new Error('Invalid login credentials') })) } });
    await expect(auth.login({ email: 'ada@example.com', password: 'wrong password' })).rejects.toThrow('Email or password is incorrect.');
  });

  it('delegates password reset delivery to Supabase Auth with the app redirect URL', async () => {
    const prior = process.env.APP_URL; process.env.APP_URL = 'http://localhost:5173';
    try {
      const result = await auth.requestPasswordReset('ADA@example.com');
      expect(result.message).toMatch(/If an account exists/);
      expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('ada@example.com', { redirectTo: 'http://localhost:5173/?type=recovery' });
    } finally { if (prior === undefined) delete process.env.APP_URL; else process.env.APP_URL = prior; }
  });

  it('requires a valid password-reset access token before changing the Supabase Auth password', async () => {
    await expect(auth.resetPassword('invalid', 'new secure password')).rejects.toThrow(BadRequestException);
    await auth.resetPassword('valid-access', 'new secure password');
    expect(supabase.auth.admin.updateUserById).toHaveBeenCalledWith('user-1', { password: 'new secure password' });
  });

  it('preserves account data and deduplicates guest tasks only after explicit transfer confirmation', async () => {
    const claimQuery = { eq: jest.fn().mockReturnThis(), or: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'guest-1' }, error: null }) };
    supabase.db.from = jest.fn(() => ({ update: jest.fn(() => claimQuery) }));
    const guestState: SpectreData = { tasks: [{ id: 'guest-1', title: 'Only guest', start: '2026-10-01', due: '2026-10-02T10:00' }, { id: 'guest-2', title: 'Existing', start: '2026-10-01', due: '2026-10-02T11:00' }], folders: ['Home'], tags: ['Planning'], notes: [], username: 'Guest' };
    const userState: SpectreData = { tasks: [{ id: 'account-copy', title: 'Existing', start: '2026-10-01', due: '2026-10-02T11:00', status: 'In Progress' }], folders: [], tags: [], notes: [], username: 'Account' };
    rows.set('guest:device-1', guestState); rows.set('user:user-1', userState);
    jest.spyOn(auth, 'getUser').mockResolvedValue({ id: 'user-1' } as any);
    jest.spyOn(auth, 'getGuestAccount').mockResolvedValue({ id: 'guest-1', device_id: 'device-1', created_at: '' });
    await expect(auth.transferGuestData('user-1', 'guest-1', false)).rejects.toThrow(BadRequestException);
    const result = await auth.transferGuestData('user-1', 'guest-1', true);
    expect(result).toEqual({ tasksTransferred: 1, notesTransferred: 0, foldersMerged: 1, tagsMerged: 1, taskIdMap: { 'guest-1': 'guest-1', 'guest-2': 'account-copy' } });
    expect(rows.get('user:user-1')?.tasks).toHaveLength(2);
    expect(rows.get('user:user-1')?.tasks[0]).toEqual(expect.objectContaining({ id: 'account-copy', status: 'In Progress' }));
    expect(rows.get('guest:device-1')?.tasks).toHaveLength(2);
  });

  it('requires an authenticated user identity for scheduled reminder routes', async () => {
    const identity = await auth.identityFromCookie(undefined);
    expect(identity).toBeUndefined();
    expect(() => auth.createGuestIdentity('not-a-uuid')).toThrow(BadRequestException);
    expect(auth.createGuestIdentity('8e8cbb5f-53ac-4e65-a45c-320d35a4fe70').type).toBe('guest');
  });

  it('claims and completes scheduled email reminders through the atomic database RPC', async () => {
    const sent: string[] = [];
    const workerAuth = {
      processDueTaskNotifications: jest.fn().mockResolvedValue(undefined),
      claimDueActions: jest.fn().mockResolvedValue([{ id: 'action-1', recipientName: 'Jamie', recipientEmail: 'jamie@example.com', subject: 'Reminder', message: 'Finish it', scheduledAt: Date.now() }]),
      createGuestReminderLink: jest.fn(async () => 'https://spectre.example/#reminder=token'),
      sendEmail: jest.fn(async (to: string) => { sent.push(to); }),
      finishAction: jest.fn(async () => undefined),
    } as any;
    const worker = new ReminderService(workerAuth);
    await worker.runDue();
    expect(sent).toEqual(['jamie@example.com']);
    expect(workerAuth.createGuestReminderLink).toHaveBeenCalledWith('action-1', expect.any(Number));
    expect(workerAuth.finishAction).toHaveBeenCalledWith('action-1');
  });

  it('stores only a hash of the guest link token and returns a link for the configured app URL', async () => {
    const inserted: any[] = [];
    supabase.db.from = jest.fn(() => ({ insert: jest.fn(async (row: any) => { inserted.push(row); return { error: null }; }) }));
    const prior = process.env.APP_URL; process.env.APP_URL = 'https://spectre.example/';
    try {
      const url = await auth.createGuestReminderLink('action-1', Date.now() + 60_000);
      const token = new URL(url).hash.match(/reminder=([A-Za-z0-9_-]+)/)?.[1];
      expect(url.startsWith('https://spectre.example/#reminder=')).toBe(true);
      expect(token).toBeTruthy();
      expect(inserted[0]).toEqual(expect.objectContaining({ scheduled_action_id: 'action-1', token_hash: createHash('sha256').update(token!).digest('hex') }));
      expect(inserted[0].token_hash).not.toBe(token);
    } finally { if (prior === undefined) delete process.env.APP_URL; else process.env.APP_URL = prior; }
  });

  it('acknowledges a guest reminder through the atomic RPC using only a token hash', async () => {
    const token = 'A'.repeat(43);
    const rpc = jest.fn(async () => ({ data: { acknowledgedAt: '2026-11-02T12:00:00.000Z' }, error: null }));
    supabase.db.rpc = rpc;
    await expect(auth.acknowledgeGuestReminder(token, '127.0.0.1')).resolves.toEqual({ acknowledgedAt: '2026-11-02T12:00:00.000Z' });
    expect(rpc).toHaveBeenCalledWith('acknowledge_guest_reminder', { p_token_hash: createHash('sha256').update(token).digest('hex') });
  });

  it('records a failed delivery for database-managed retry instead of reporting success', async () => {
    const workerAuth = {
      processDueTaskNotifications: jest.fn().mockResolvedValue(undefined),
      claimDueActions: jest.fn().mockResolvedValue([{ id: 'action-2', recipientName: 'Jamie', recipientEmail: 'jamie@example.com', subject: 'Reminder', message: 'Finish it', scheduledAt: Date.now() }]),
      createGuestReminderLink: jest.fn(async () => 'https://spectre.example/#reminder=token'),
      sendEmail: jest.fn(async () => { throw new Error('provider unavailable'); }),
      finishAction: jest.fn(async () => undefined),
    } as any;
    await new ReminderService(workerAuth).runDue();
    expect(workerAuth.finishAction).toHaveBeenCalledWith('action-2', 'provider unavailable');
  });

  it('sends reminder messages through Resend with the configured sender and API key', async () => {
    const originalKey = process.env.RESEND_API_KEY; const originalFrom = process.env.EMAIL_FROM;
    process.env.RESEND_API_KEY = 're_test_key'; process.env.EMAIL_FROM = 'Spectre <reminders@example.com>';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    try {
      await auth.sendEmail('michael@example.com', 'Reminder', 'Please do this', '<p>Please do this</p>');
      expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer re_test_key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Spectre <reminders@example.com>', to: ['michael@example.com'], subject: 'Reminder', text: 'Please do this', html: '<p>Please do this</p>' }),
      }));
    } finally {
      fetchMock.mockRestore();
      if (originalKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalKey;
      if (originalFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = originalFrom;
    }
  });
});
