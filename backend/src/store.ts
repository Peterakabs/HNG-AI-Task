import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

@Injectable()
export class ScopeContext {
  private readonly storage = new AsyncLocalStorage<string>();
  run<T>(scope: string, callback: () => T): T { return this.storage.run(scope, callback); }
  current(): string { return this.storage.getStore() || 'guest:legacy-default'; }
}

export interface SpectreData {
  tasks: Record<string, any>[];
  folders: string[];
  tags: string[];
  notes: Record<string, any>[];
  username: string;
}

const newId = () => randomUUID();

@Injectable()
export class JsonStore {
  readonly filePath: string;
  private readonly scopesPath: string;
  private readonly scopeContext: ScopeContext;

  constructor(scopeContext: ScopeContext, @Optional() @Inject('SPECTRE_DATA_FILE') filePath?: string) {
    filePath ||= process.env.SPECTRE_DATA_FILE || join(process.cwd(), '.data', 'spectre.json');
    this.filePath = filePath;
    this.scopesPath = `${filePath}.scopes`;
    this.scopeContext = scopeContext;
    const folder = dirname(filePath);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    if (!existsSync(filePath)) {
      const starter: SpectreData = {
        tasks: [], folders: ['Personal', 'Work'], tags: [], notes: [],
        username: `User${Math.floor(1000 + Math.random() * 9000)}`,
      };
      writeFileSync(filePath, JSON.stringify(starter, null, 2));
    }
  }

  read(scope = this.scopeContext.current()): SpectreData {
    if (scope === 'guest:legacy-default') return JSON.parse(readFileSync(this.filePath, 'utf8')) as SpectreData;
    const path = this.scopePath(scope);
    if (!existsSync(path)) {
      const legacyMarker = join(this.scopesPath, 'legacy-owner');
      if (scope.startsWith('guest:') && !existsSync(legacyMarker)) {
        const legacy = JSON.parse(readFileSync(this.filePath, 'utf8')) as SpectreData;
        this.writeAt(path, legacy);
        writeFileSync(legacyMarker, scope);
        return legacy;
      }
      return this.emptyData();
    }
    return JSON.parse(readFileSync(path, 'utf8')) as SpectreData;
  }

  write(data: SpectreData, scope = this.scopeContext.current()): void {
    if (scope === 'guest:legacy-default') return this.writeAt(this.filePath, data);
    this.writeAt(this.scopePath(scope), data);
  }

  private writeAt(path: string, data: SpectreData): void {
    const folder = dirname(path);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2));
    renameSync(temporary, path);
  }

  private scopePath(scope: string): string {
    const safe = Buffer.from(scope).toString('base64url');
    return join(this.scopesPath, `${safe}.json`);
  }
  private emptyData(): SpectreData { return { tasks: [], folders: [], tags: [], notes: [], username: `User${Math.floor(1000 + Math.random() * 9000)}` }; }
  copyGuestToAccount(deviceId: string, userId: string): void {
    const guest = this.read(`guest:${deviceId}`); const accountScope = `user:${userId}`; const account = this.read(accountScope);
    if (account.tasks.length || account.notes.length) return;
    account.tasks = guest.tasks; account.folders = guest.folders; account.tags = guest.tags; account.notes = guest.notes; account.username = guest.username;
    this.write(account, accountScope);
  }

  id(): string { return newId(); }
}
