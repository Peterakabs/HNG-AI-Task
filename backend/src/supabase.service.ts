import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private client?: SupabaseClient;
  private readonly url = process.env.SUPABASE_URL || 'https://lgseazfkoqaozavyozno.supabase.co';
  private readonly key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  onModuleInit() {
    if (!this.key) return;
    this.client = createClient(this.url, this.key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }

  get auth(): SupabaseClient['auth'] { return this.requireClient().auth; }
  get db(): SupabaseClient { return this.requireClient(); }
  get configured() { return Boolean(this.key); }
  newClient(): SupabaseClient {
    this.requireClient();
    return createClient(this.url, this.key!, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  }

  async checkConnection() {
    const client = this.requireClient();
    try {
      const { error } = await client.from('spectre_data').select('owner_key').limit(1);
      if (error) throw new Error(error.message, { cause: error });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const cause = failure.cause instanceof Error ? failure.cause : undefined;
      const causeCode = cause && 'code' in cause ? String((cause as NodeJS.ErrnoException).code || '') : '';
      const detail = [causeCode, cause?.message, failure.message].filter(Boolean).join(': ');
      this.logger.error(`Supabase request failed for ${this.url}: ${detail}`);
      throw new ServiceUnavailableException(`Supabase database connection failed: ${detail}`);
    }
    return { status: 'ok', service: 'spectre-api', database: 'supabase' };
  }

  private requireClient() {
    if (!this.client) throw new ServiceUnavailableException('Supabase is not configured. Set SUPABASE_SECRET_KEY in the backend environment.');
    return this.client;
  }
}
