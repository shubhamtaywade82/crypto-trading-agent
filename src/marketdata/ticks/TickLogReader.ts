import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import type { TickEvent } from './types.js';

export interface TickLogReaderOptions {
  dir: string;
  symbol: string;
  day?: string;
  hour?: string;
  /** Throw on a sha256 mismatch; unmanifested files are reported but tolerated. */
  verify?: boolean;
}

export interface TickVerifyReport {
  files: number;
  events: number;
  errors: string[];
}

interface ManifestEntry {
  file: string;
  sha256: string;
  count: number;
}

/** Reads back one symbol's raw log in capture order, decompressing zstd files and checking the manifest. */
export class TickLogReader {
  constructor(private readonly options: TickLogReaderOptions) {}

  async files(): Promise<string[]> {
    const root = path.join(this.options.dir, this.options.day ?? '');
    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const pattern = new RegExp(`^${escape(this.options.symbol)}(\\.\\d+)*\\.jsonl(\\.zst)?$`);
    const matches = entries
      .filter((entry) => pattern.test(path.basename(entry)))
      .filter((entry) => !this.options.hour || entry.split(path.sep).includes(this.options.hour))
      .map((entry) => path.join(root, entry));
    return this.sortByStart(matches);
  }

  async *events(): AsyncGenerator<TickEvent> {
    const manifest = await this.manifest();
    for (const file of await this.files()) {
      let count = 0;
      const hash = createHash('sha256');
      for await (const event of this.read(file, hash)) {
        count += 1;
        yield event;
      }
      this.check(file, hash.digest('hex'), count, manifest);
    }
  }

  async verify(): Promise<TickVerifyReport> {
    const manifest = await this.manifest();
    const report: TickVerifyReport = { files: 0, events: 0, errors: [] };
    for (const file of await this.files()) {
      const hash = createHash('sha256');
      let count = 0;
      for await (const _event of this.read(file, hash)) count += 1;
      report.files += 1;
      report.events += count;
      try {
        this.check(file, hash.digest('hex'), count, manifest);
      } catch (err) {
        report.errors.push((err as Error).message);
      }
    }
    return report;
  }

  private async *read(file: string, hash: ReturnType<typeof createHash>): AsyncGenerator<TickEvent> {
    let tail = '';
    for await (const chunk of this.source(file)) {
      hash.update(chunk as Buffer);
      tail += (chunk as Buffer).toString('utf8');
      let newline = tail.indexOf('\n');
      while (newline >= 0) {
        const line = tail.slice(0, newline).trim();
        tail = tail.slice(newline + 1);
        if (line) yield JSON.parse(line) as TickEvent;
        newline = tail.indexOf('\n');
      }
    }
    if (tail.trim()) yield JSON.parse(tail) as TickEvent;
  }

  private source(file: string): Readable {
    const raw = createReadStream(file);
    if (!file.endsWith('.zst')) return raw;
    const zstd = createZstdDecompress();
    raw.on('error', (err) => zstd.destroy(err));
    raw.pipe(zstd);
    return zstd;
  }

  private async sortByStart(files: string[]): Promise<string[]> {
    const withStart = await Promise.all(files.map(async (file) => ({ file, start: await this.startedAt(file) })));
    return withStart.sort((a, b) => a.start - b.start || a.file.localeCompare(b.file)).map((entry) => entry.file);
  }

  private async startedAt(file: string): Promise<number> {
    try {
      for await (const event of this.read(file, createHash('sha256'))) {
        if (event.kind === 'meta' && typeof (event.data as { startedAt?: unknown }).startedAt === 'number') {
          return (event.data as { startedAt: number }).startedAt;
        }
        return (await stat(file)).mtimeMs;
      }
    } catch {
      // A corrupt header falls back to mtime; verification reports the real problem.
    }
    return (await stat(file)).mtimeMs;
  }

  private async manifest(): Promise<Map<string, ManifestEntry>> {
    const map = new Map<string, ManifestEntry>();
    try {
      const text = await readFile(path.join(this.options.dir, 'manifest.jsonl'), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ManifestEntry;
          if (entry.file && entry.sha256) map.set(entry.file, entry);
        } catch {
          // A torn last line from a crash is not a reason to refuse the rest of the manifest.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return map;
  }

  private check(file: string, sha256: string, count: number, manifest: Map<string, ManifestEntry>): void {
    if (this.options.verify === false) return;
    const relative = path.relative(this.options.dir, file);
    const entry = manifest.get(relative);
    if (!entry) return;
    if (entry.sha256 !== sha256) throw new Error(`${relative}: sha256 mismatch`);
    if (entry.count !== count) throw new Error(`${relative}: expected ${entry.count} events, read ${count}`);
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
