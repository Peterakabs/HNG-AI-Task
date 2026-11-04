import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from './supabase.service';

const MAX_SIZE = 5 * 1024 * 1024;
const TYPES = {
  'image/jpeg': { ext: 'jpg', matches: (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', matches: (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/webp': { ext: 'webp', matches: (b: Buffer) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
} as const;

@Injectable()
export class ProfileImageService {
  constructor(private readonly supabase: SupabaseService) {}
  private get bucket() { return process.env.SUPABASE_PROFILE_BUCKET?.trim() || 'profile-pictures'; }

  async avatarUrl(userId: string) {
    const { data, error } = await this.supabase.db.from('profiles').select('avatar_path,avatar_updated_at').eq('id', userId).maybeSingle();
    if (error) throw new ServiceUnavailableException('Your profile could not be loaded. Please try again.');
    if (!data?.avatar_path) return undefined;
    const version = data.avatar_updated_at ? new Date(data.avatar_updated_at).getTime() : Date.now();
    return `/api/profile/avatar?v=${version}`;
  }

  async upload(userId: string, file: { buffer?: Buffer; mimetype?: string; size?: number }) {
    const bytes = file?.buffer;
    if (!bytes?.length) throw new BadRequestException('Choose a photo to upload.');
    if (bytes.length > MAX_SIZE || (file.size || 0) > MAX_SIZE) throw new BadRequestException('Choose an image smaller than 5 MB.');
    const type = file.mimetype as keyof typeof TYPES;
    const format = TYPES[type];
    if (!format || !format.matches(bytes)) throw new BadRequestException('Use a valid JPG, PNG, or WebP image.');

    const path = `users/${userId}/${randomUUID()}.${format.ext}`;
    const { error: uploadError } = await this.supabase.db.storage.from(this.bucket).upload(path, bytes, { contentType: type, upsert: false, cacheControl: '3600' });
    if (uploadError) {
      if (/bucket not found|not found/i.test(uploadError.message)) throw new ServiceUnavailableException('Profile photo storage is not ready. Please contact support.');
      throw new ServiceUnavailableException('Your photo could not be uploaded. Please try again.');
    }

    const { data: previous, error: readError } = await this.supabase.db.from('profiles').select('avatar_path').eq('id', userId).maybeSingle();
    if (readError) {
      await this.supabase.db.storage.from(this.bucket).remove([path]);
      throw new ServiceUnavailableException('Your profile could not be updated. Please try again.');
    }
    const now = new Date().toISOString();
    const { error: saveError } = await this.supabase.db.from('profiles').upsert({ id: userId, avatar_path: path, avatar_updated_at: now }, { onConflict: 'id' });
    if (saveError) {
      await this.supabase.db.storage.from(this.bucket).remove([path]);
      throw new ServiceUnavailableException('Your profile could not be updated. Please try again.');
    }
    const oldPath = previous?.avatar_path;
    if (typeof oldPath === 'string' && oldPath.startsWith(`users/${userId}/`) && oldPath !== path) {
      const { error: removeError } = await this.supabase.db.storage.from(this.bucket).remove([oldPath]);
      if (removeError) console.warn('[Spectre] Could not remove replaced profile photo.');
    }
    return { avatarUrl: `/api/profile/avatar?v=${Date.parse(now)}`, avatarUpdatedAt: now };
  }

  async download(userId: string) {
    const { data: profile, error } = await this.supabase.db.from('profiles').select('avatar_path').eq('id', userId).maybeSingle();
    if (error) throw new ServiceUnavailableException('Your profile photo could not be loaded. Please try again.');
    const path = profile?.avatar_path;
    if (typeof path !== 'string' || !path.startsWith(`users/${userId}/`)) throw new NotFoundException('No profile photo has been added.');
    const { data, error: downloadError } = await this.supabase.db.storage.from(this.bucket).download(path);
    if (downloadError || !data) throw new NotFoundException('This profile photo is no longer available.');
    const type = data.type && Object.keys(TYPES).includes(data.type) ? data.type : path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return { buffer: Buffer.from(await data.arrayBuffer()), contentType: type };
  }
}
