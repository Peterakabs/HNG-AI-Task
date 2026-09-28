import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

  constructor(@Optional() @Inject('SPECTRE_DATA_FILE') filePath?: string) {
    filePath ||= process.env.SPECTRE_DATA_FILE || join(process.cwd(), '.data', 'spectre.json');
    this.filePath = filePath;
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

  read(): SpectreData {
    return JSON.parse(readFileSync(this.filePath, 'utf8')) as SpectreData;
  }

  write(data: SpectreData): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2));
    renameSync(temporary, this.filePath);
  }

  id(): string { return newId(); }
}
