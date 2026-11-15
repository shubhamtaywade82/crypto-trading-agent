import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One small JSON document, replaced atomically (write to a temp file, then rename) so a crash never leaves half of it. */
export class JsonStateStore<T> {
  constructor(private readonly filePath: string) {}

  /** Null when the file is missing. An unreadable file throws: silently starting fresh would forget a tripped breaker. */
  load(): T | null {
    if (!existsSync(this.filePath)) return null;
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as T;
    } catch (error) {
      throw new Error(`${this.filePath} is unreadable; fix or remove it deliberately: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  save(state: T): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, this.filePath);
  }
}
