import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const runSupabaseE2E = process.env.SPECTRE_RUN_SUPABASE_E2E === 'true' && Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

(runSupabaseE2E ? describe : describe.skip)('Spectre API (Supabase integration)', () => {
  let app: INestApplication;
  let admin: SupabaseClient;
  const deviceId = randomUUID();
  const client = () => request(app.getHttpServer());

  beforeAll(async () => {
    const url = process.env.SUPABASE_URL || 'https://lgseazfkoqaozavyozno.supabase.co';
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
    admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // The workspace may resolve the Nest interface through two equivalent
    // package paths (pnpm virtual store and workspace link); the runtime app is
    // the same, so bridge the duplicate declaration for this integration test.
    app = moduleRef.createNestApplication() as unknown as INestApplication;
    await app.init();
  });

  afterAll(async () => {
    if (admin) {
      await admin.from('spectre_data').delete().eq('owner_key', `guest:${deviceId}`);
      await admin.from('guest_accounts').delete().eq('device_id', deviceId);
    }
    await app?.close();
  });

  it('stores guest tasks in Supabase and restores them through the guest cookie', async () => {
    const guest = request.agent(app.getHttpServer());
    await guest.post('/api/auth/guest').set('x-device-id', deviceId).send({}).expect(201);
    const created = await guest.post('/api/tasks').send({ title: 'Supabase test task', start: '2026-09-28', due: '2026-09-29T09:30', status: 'To Do', priority: 'Medium' }).expect(201);
    expect(created.body.title).toBe('Supabase test task');
    const tasks = await guest.get('/api/tasks').expect(200);
    expect(tasks.body).toEqual([expect.objectContaining({ id: created.body.id, title: 'Supabase test task' })]);
    const row = await admin.from('spectre_data').select('data').eq('owner_key', `guest:${deviceId}`).single();
    expect(row.data?.data.tasks).toHaveLength(1);
  });
});
