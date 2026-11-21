import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import { nowNs, type TickEvent, type TickKind, type TickMeta } from './types.js';

export interface TickLogWriterOptions {
  dir: string;
  symbol: string;
  compress?: boolean;
  /** Per-symbol cap for one UTC day; the writer stops instead of filling the disk. */
  maxBytesPerDay?: number;
  minFreeBytes?: number;
  now?: () => number;
  onError?: (err: Error) => void;
}

interface ActiveFile {
  hour: string;
  file: string;
  stream: ReturnType<typeof createWriteStream>;
  hash: Hash;
  count: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  startedAt: number;
}

const DEFAULT_MAX_BYTES = 4_000_000_000;
const DEFAULT_MIN_FREE = 2_000_000_000;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcHour = (ms: number): string => new Date(ms).toISOString().slice(11, 13);
const hourKey = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

/** One symbol's raw JSONL log: hourly files, zstd on rotation, a sha256 manifest and a per-symbol lock. */
export class TickLogWriter {
  private active: ActiveFile | null = null;
  private seq = 0;
  private day = '';
  private dayBytes = 0;
  private closed = false;
  private failure: Error | null = null;
  private readonly pending = new Set<Promise<void>>();
  private lockPath = '';
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly minFree: number;

  constructor(private readonly options: TickLogWriterOptions) {
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES;
    this.minFree = options.minFreeBytes ?? DEFAULT_MIN_FREE;
  }

  get failed(): Error | null {
    return this.failure;
  }

  pendingBytes(): number {
    return this.active?.stream.writableLength ?? 0;
  }

  async open(meta: TickMeta): Promise<void> {
    mkdirSync(this.options.dir, { recursive: true });
    this.lockPath = path.join(this.options.dir, '.locks', `${this.options.symbol}.lock`);
    this.acquireLock();
    try {
      this.startFile(this.now());
      this.append('meta', meta);
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  /** Synchronous so the feed tap never blocks; rotation starts the compression in the background. */
  append(kind: TickKind, data: unknown, stream?: string, recvNs?: string): void {
    if (this.closed || this.failure || !this.active) return;
    const now = this.now();
    if (hourKey(now) !== this.active.hour) this.rotate(now);
    if (!this.active) return;
    const ns = recvNs ?? nowNs(now);
    const event: TickEvent = { seq: this.seq++, recvNs: ns, kind, ...(stream ? { stream } : {}), data };
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line);
    if (this.day !== utcDay(now)) { this.day = utcDay(now); this.dayBytes = 0; }
    if (this.dayBytes + size > this.maxBytes) {
      this.fail(new Error(`tick log ${this.options.symbol} reached ${this.maxBytes} bytes for ${this.day}`));
      return;
    }
    this.dayBytes += size;
    this.writeLine(line, size);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.finishActive();
      await Promise.all([...this.pending]);
    } finally {
      this.releaseLock();
    }
  }

  private writeLine(line: string, size: number): void {
    const active = this.active!;
    active.hash.update(line);
    active.count += 1;
    active.bytes += size;
    active.lastSeq = this.seq - 1;
    active.stream.write(line);
  }

  private rotate(now: number): void {
    const finished = this.active;
    this.active = null;
    if (finished) {
      const done = this.finishOne(finished);
      this.pending.add(done);
      void done.finally(() => this.pending.delete(done));
    }
    try {
      this.startFile(now);
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private startFile(now: number): void {
    const dir = path.join(this.options.dir, utcDay(now), utcHour(now));
    mkdirSync(dir, { recursive: true });
    this.assertFreeSpace(dir);
    const file = this.uniqueFile(dir, now);
    const stream = createWriteStream(file, { flags: 'wx', highWaterMark: 1 << 20 });
    stream.on('error', (err) => this.fail(err));
    this.active = {
      hour: hourKey(now), file, stream, hash: createHash('sha256'), count: 0, bytes: 0,
      firstSeq: this.seq, lastSeq: this.seq - 1, startedAt: now,
    };
  }

  private uniqueFile(dir: string, now: number): string {
    const base = path.join(dir, `${this.options.symbol}.jsonl`);
    if (!existsSync(base)) return base;
    let candidate = path.join(dir, `${this.options.symbol}.${now}.jsonl`);
    for (let n = 1; existsSync(candidate); n += 1) candidate = path.join(dir, `${this.options.symbol}.${now}.${n}.jsonl`);
    return candidate;
  }

  private assertFreeSpace(dir: string): void {
    const stats = statfsSync(dir);
    if (stats.bavail * stats.bsize < this.minFree) throw new Error(`tick log ${this.options.symbol}: free space below ${this.minFree} bytes`);
  }

  private async finishActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active) await this.finishOne(active);
  }

  private async finishOne(active: ActiveFile): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      active.stream.once('error', reject);
      active.stream.end(() => resolve());
    });
    await this.finalize(active);
  }

  private async finalize(active: ActiveFile): Promise<void> {
    if (this.failure) return;
    let file = active.file;
    let compression = 'none';
    if (this.options.compress !== false) {
      try {
        const zst = `${file}.zst`;
        await pipeline(createReadStream(file), createZstdCompress(), createWriteStream(zst));
        await unlink(file);
        file = zst;
        compression = 'zstd';
      } catch (err) {
        this.options.onError?.(err as Error);
      }
    }
    const compressedBytes = (await stat(file)).size;
    const entry = {
      file: path.relative(this.options.dir, file), symbol: this.options.symbol, startedAt: active.startedAt,
      endedAt: this.now(), firstSeq: active.firstSeq, lastSeq: active.lastSeq, count: active.count,
      bytes: active.bytes, sha256: active.hash.digest('hex'), compressedBytes, compression,
    };
    await appendFile(path.join(this.options.dir, 'manifest.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.options.onError?.(err);
  }

  private acquireLock(): void {
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    try {
      writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(this.lockPath, 'utf8').trim());
      if (pid > 0 && alive(pid)) throw new Error(`tick log ${this.options.symbol} is already open by pid ${pid}`);
      writeFileSync(this.lockPath, String(process.pid));
    }
  }

  private releaseLock(): void {
    try { if (this.lockPath) unlinkSync(this.lockPath); } catch { /* already gone */ }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
