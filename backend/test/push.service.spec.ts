import { createECDH, randomBytes } from 'node:crypto';
import { PushService } from '../src/push.service';

describe('PushService', () => {
  const previous = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    const vapid = createECDH('prime256v1'); vapid.generateKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.getPublicKey().toString('base64url');
    process.env.VAPID_PRIVATE_KEY = vapid.getPrivateKey().toString('base64url');
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 201 } as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (previous.publicKey === undefined) delete process.env.VAPID_PUBLIC_KEY; else process.env.VAPID_PUBLIC_KEY = previous.publicKey;
    if (previous.privateKey === undefined) delete process.env.VAPID_PRIVATE_KEY; else process.env.VAPID_PRIVATE_KEY = previous.privateKey;
    if (previous.subject === undefined) delete process.env.VAPID_SUBJECT; else process.env.VAPID_SUBJECT = previous.subject;
  });

  it('encrypts a reminder and sends an authenticated Web Push request', async () => {
    const browser = createECDH('prime256v1'); browser.generateKeys();
    const result = await new PushService().send({ endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: browser.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, { title: 'Read', body: 'Due now', taskId: 'task-1' });
    expect(result).toEqual({ sent: true, gone: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toEqual(expect.objectContaining({ 'Content-Encoding': 'aes128gcm', TTL: '86400' }));
    expect(request.body).toBeInstanceOf(Buffer);
    expect((request.body as Buffer).length).toBeGreaterThan(80);
  });

  it('reports expired browser subscriptions for cleanup', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410 } as Response);
    const browser = createECDH('prime256v1'); browser.generateKeys();
    const result = await new PushService().send({ endpoint: 'https://fcm.googleapis.com/fcm/send/gone', p256dh: browser.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, { title: 'Read', body: 'Due now' });
    expect(result).toEqual({ sent: false, gone: true });
  });

  it('rejects endpoints outside known push services', async () => {
    await expect(new PushService().send({ endpoint: 'https://127.0.0.1/private', p256dh: '', auth: '' }, { title: 'x', body: 'y' })).rejects.toThrow('Invalid push endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
