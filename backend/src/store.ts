import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SupabaseService } from './supabase.service';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';

@Injectable()
export class ScopeContext {
  private readonly storage = new AsyncLocalStorage<string>();
  run<T>(scope: string, callback: () => T): T { return this.storage.run(scope, callback); }
  current(): string { return this.storage.getStore() || 'guest:legacy-default'; }
}

export interface SpectreData {
  tasks: Record<string, any>[];
  weeklySummaries?: Record<string, any>[];
  weeklySummaryThrough?: string;
  folders: string[];
  tags: string[];
  notes: Record<string, any>[];
  username: string;
  phone?: string;
  avatarUrl?: string;
}

@Injectable()
export class SupabaseStore {
  constructor(private readonly scopes: ScopeContext, private readonly supabase: SupabaseService) {}
  id(): string { return randomUUID(); }

  async read(scope = this.scopes.current()): Promise<SpectreData> {
    const { data, error } = await this.supabase.db.from('spectre_data').select('data,revision').eq('owner_key', scope).maybeSingle();
    if (error) throw new InternalServerErrorException(`Could not load app data from Supabase: ${error.message}`);
    if (data?.data) return this.attachRevision(data.data as SpectreData, data.revision || 0);
    const initial = this.emptyData();
    const { data: inserted, error: insertError } = await this.supabase.db.from('spectre_data').insert({ owner_key: scope, data: initial }).select('data').single();
    if (!insertError) return this.attachRevision(inserted.data as SpectreData, 0);
    if (insertError.code === '23505') {
      const { data: concurrent, error: retryError } = await this.supabase.db.from('spectre_data').select('data,revision').eq('owner_key', scope).single();
      if (!retryError && concurrent?.data) return this.attachRevision(concurrent.data as SpectreData, concurrent.revision || 0);
    }
    throw new InternalServerErrorException(`Could not initialize app data in Supabase: ${insertError.message}`);
  }

  async write(value: SpectreData, scope = this.scopes.current()): Promise<void> {
    const revision = (value as SpectreData & { __revision?: number }).__revision ?? 0;
    const { data, error } = await this.supabase.db.from('spectre_data').update({ data: value, revision: revision + 1, updated_at: new Date().toISOString() }).eq('owner_key', scope).eq('revision', revision).select('revision').maybeSingle();
    if (error) throw new InternalServerErrorException(`Could not save app data to Supabase: ${error.message}`);
    if (!data) throw new ConflictException('Your data changed in another request. Refresh and try again.');
    this.attachRevision(value, data.revision);
  }

  private attachRevision(data: SpectreData, revision: number) {
    data.weeklySummaries ??= [];
    Object.defineProperty(data, '__revision', { value: revision, writable: true, configurable: true, enumerable: false });
    return data;
  }
  private emptyData(): SpectreData { return { tasks: [], weeklySummaries: [], folders: ['Personal', 'Work'], tags: [], notes: [], username: `User${Math.floor(1000 + Math.random() * 9000)}` }; }
}
