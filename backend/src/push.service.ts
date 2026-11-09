import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

type PushSubscription = { endpoint: string; p256dh: string; auth: string };

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  get available() { return Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim() && /^(mailto:\S+|https:\/\/\S+)$/i.test(process.env.VAPID_SUBJECT?.trim() || '')); }
  get publicKey() { return process.env.VAPID_PUBLIC_KEY?.trim() || ''; }

  async send(subscription: PushSubscription, message: { title: string; body: string; taskId?: string | null }) {
    if (!this.available) return { sent: false, gone: false };
    const endpoint = new URL(subscription.endpoint);
    const trustedPushHost = endpoint.hostname === 'fcm.googleapis.com'
      || endpoint.hostname === 'push.services.mozilla.com'
      || endpoint.hostname.endsWith('.push.services.mozilla.com')
      || endpoint.hostname.endsWith('.notify.windows.com')
      || endpoint.hostname.endsWith('.push.apple.com');
    if (endpoint.protocol !== 'https:' || endpoint.port && endpoint.port !== '443' || !trustedPushHost) throw new Error('Invalid push endpoint.');
    const encrypted = this.encrypt(subscription, JSON.stringify(message));
    const token = this.vapidToken(endpoint.origin);
    const response = await fetch(endpoint, { method: 'POST', headers: {
      Authorization: `vapid t=${token}, k=${this.publicKey}`,
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400',
    }, body: encrypted });
    if (response.status === 404 || response.status === 410) return { sent: false, gone: true };
    if (!response.ok) throw new Error(`Push service returned ${response.status}.`);
    return { sent: true, gone: false };
  }

  private vapidToken(audience: string) {
    const publicKey = this.decode(process.env.VAPID_PUBLIC_KEY!);
    const privateKey = this.decode(process.env.VAPID_PRIVATE_KEY!);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) throw new Error('VAPID keys must be a P-256 public key and 32-byte private key.');
    const header = this.base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const payload = this.base64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: process.env.VAPID_SUBJECT!.trim() }));
    const [x, y] = [publicKey.subarray(1, 33), publicKey.subarray(33, 65)];
    const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: this.base64url(x), y: this.base64url(y), d: this.base64url(privateKey) }, format: 'jwk' });
    const input = `${header}.${payload}`;
    return `${input}.${this.base64url(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
  }

  private encrypt(subscription: PushSubscription, payload: string) {
    const userPublic = this.decode(subscription.p256dh);
    const userAuth = this.decode(subscription.auth);
    if (userPublic.length !== 65 || userPublic[0] !== 4 || userAuth.length < 16) throw new Error('Invalid browser push subscription keys.');
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const serverPublic = ecdh.getPublicKey();
    const sharedSecret = ecdh.computeSecret(userPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, serverPublic]);
    const inputKey = this.hkdfExpand(this.hkdfExtract(userAuth, sharedSecret), keyInfo, 32);
    const salt = randomBytes(16);
    const prk = this.hkdfExtract(salt, inputKey);
    const cek = this.hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = this.hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const recordSize = Buffer.alloc(4); recordSize.writeUInt32BE(4096);
    return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, encrypted]);
  }

  private hkdfExtract(salt: Buffer, input: Buffer) { return createHmac('sha256', salt).update(input).digest(); }
  private hkdfExpand(prk: Buffer, info: Buffer, length: number) {
    const blocks: Buffer[] = []; let previous = Buffer.alloc(0); let size = 0;
    for (let index = 1; size < length; index += 1) { previous = createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([index])])).digest(); blocks.push(previous); size += previous.length; }
    return Buffer.concat(blocks).subarray(0, length);
  }
  private decode(value: string) { return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
  private base64url(value: string | Buffer) { return Buffer.from(value).toString('base64url'); }
}
