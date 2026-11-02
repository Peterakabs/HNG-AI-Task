import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private client?: SupabaseClient;
  private get url() { return process.env.SUPABASE_URL?.trim() || 'https://lgseazfkoqaozavyozno.supabase.co'; }
  private get key() { return process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(); }

  onModuleInit() {
    // Log presence only: never print credential values to deployment logs.
    this.logger.log(
      `Environment check: SUPABASE_SECRET_KEY=${process.env.SUPABASE_SECRET_KEY?.trim() ? 'present' : 'missing'}, ` +
      `SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ? 'present' : 'missing'}, ` +
      `SUPABASE_URL=${process.env.SUPABASE_URL?.trim() ? 'present' : 'using default'}`,
    );
    this.initializeClient();
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

  private initializeClient() {
    if (this.client || !this.key) return;
    this.client = createClient(this.url, this.key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }

  private requireClient() {
    // Lazily initialize too: other providers can first use Supabase during
    // their own onModuleInit hook, before this provider's hook has run.
    this.initializeClient();
    if (!this.client) throw new ServiceUnavailableException('Supabase is not configured. Set SUPABASE_SECRET_KEY in the backend environment.');
    return this.client;
  }
}
