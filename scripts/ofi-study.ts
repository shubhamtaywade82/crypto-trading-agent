/**
 * §34 OFI Stage A (supersedes the §33 runner). Raw bookTicker/aggTrades archive zips are kept immutably with SHA-256 in a manifest;
 * per-second features are derived from them and cached separately. Statistics live in src/research/OfiAnalysis.ts.
 *
 *   npx tsx scripts/ofi-study.ts [--symbols ETHUSDT,SOLUSDT] [--from 2024-02-01] [--to 2024-03-31]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { analyseSymbol, FIELDS, SECONDS } from '../src/research/OfiAnalysis.js';

const flag = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const SYMBOLS = flag('symbols', 'ETHUSDT,SOLUSDT').split(',');
const FROM = Date.parse(`${flag('from', '2024-02-01')}T00:00:00Z`);
const TO = Date.parse(`${flag('to', '2024-03-31')}T00:00:00Z`);
const RAW = 'data/cache/vision-raw/futures/um/daily';
const FEATURES = 'data/cache/ticks/ofi-1s';
const MANIFEST = 'data/cache/vision-raw/manifest-ofi.json';
const DAY_MS = 86_400_000;
const PAUSE_MS = 3_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Raw archive zip on disk (downloaded once, kept, hashed into the manifest). */
async function rawZip(dataset: string, symbol: string, day: string, manifest: Record<string, string>): Promise<Buffer> {
  const rel = `${dataset}/${symbol}/${symbol}-${dataset}-${day}.zip`;
  const file = path.join(RAW, rel);
  if (!existsSync(file)) {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`https://data.binance.vision/data/futures/um/daily/${rel}`, { signal: AbortSignal.timeout(900_000) }).catch(() => null);
      if (response?.status === 429 || response?.status === 418) throw new Error(`rate limited ${response.status} on ${rel}: stopping`);
      if (response?.status === 404) throw new Error(`${rel} not in archive`);
      const body = response?.ok ? await response.arrayBuffer().catch(() => null) : null;
      if (body) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(body)); break; }
      if (attempt >= 3) throw new Error(`${rel}: download failed 3 times`);
      await sleep(60_000 * attempt);
    }
    await sleep(PAUSE_MS);
  }
  const zip = readFileSync(file);
  manifest[rel] ??= createHash('sha256').update(zip).digest('hex');
  return zip;
}

/** Text lines of the first zip entry, streamed (a bookTicker day is 0.5–2 GB of text). */
async function* lines(zip: Buffer): AsyncGenerator<string> {
  const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  let rest = '';
  for await (const chunk of Readable.from([zip.subarray(start)]).pipe(createInflateRaw())) {
    const parts = (rest + (chunk as Buffer).toString('latin1')).split('\n');
    rest = parts.pop()!;
    yield* parts;
  }
  if (rest) yield rest;
}

/** Per second: [last mid, sum spread bps, OFI (base units), book updates, aggressor-buy quote, aggressor-sell quote]. */
async function reduceDay(symbol: string, dayStart: number, manifest: Record<string, string>): Promise<Float64Array> {
  const out = new Float64Array(SECONDS * FIELDS);
  for (let s = 0; s < SECONDS; s += 1) out[s * FIELDS] = NaN;
  const day = isoDay(dayStart);
  let prev: number[] | null = null;
  for await (const line of lines(await rawZip('bookTicker', symbol, day, manifest))) {
    const c = line.split(',');
    const [bid, bidQty, ask, askQty, time] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5])];
    const second = Math.floor((time - dayStart) / 1000);
    if (!(second >= 0 && second < SECONDS) || !(ask > bid) || !Number.isFinite(bidQty)) continue; // header, crossed or out-of-day rows
    const o = second * FIELDS;
    out[o] = (bid + ask) / 2; out[o + 1]! += ((ask - bid) / out[o]!) * 1e4; out[o + 3]! += 1;
    // Cont–Kukanov–Stoikov: at an unchanged price both terms apply, so the queue *change* counts (not the full new size)
    if (prev) out[o + 2]! += (bid >= prev[0]! ? bidQty : 0) - (bid <= prev[0]! ? prev[1]! : 0) - (ask <= prev[2]! ? askQty : 0) + (ask >= prev[2]! ? prev[3]! : 0);
    prev = [bid, bidQty, ask, askQty];
  }
  for await (const line of lines(await rawZip('aggTrades', symbol, day, manifest))) {
    const c = line.split(',');
    const second = Math.floor((Number(c[5]) - dayStart) / 1000);
    const quote = Number(c[1]) * Number(c[2]);
    if (!(second >= 0 && second < SECONDS) || !Number.isFinite(quote)) continue;
    out[second * FIELDS + (c[6]!.trim() === 'false' ? 4 : 5)]! += quote; // is_buyer_maker = false: the buyer was the aggressor
  }
  return out;
}

async function loadDay(symbol: string, dayStart: number, manifest: Record<string, string>): Promise<Float64Array> {
  const file = path.join(FEATURES, symbol, `${symbol}-${isoDay(dayStart)}.bin`);
  if (existsSync(file)) { const b = readFileSync(file); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  const reduced = await reduceDay(symbol, dayStart, manifest);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(reduced.buffer));
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`  ${symbol} ${isoDay(dayStart)} reduced`);
  return reduced;
}

async function main(): Promise<void> {
  const manifest: Record<string, string> = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string> : {};
  const days = Math.round((TO - FROM) / DAY_MS);
  const verdicts: { h1: boolean; h2: boolean }[] = [];
  for (const symbol of SYMBOLS) {
    const series: Float64Array[] = [];
    for (let d = 0; d < days; d += 1) series.push(await loadDay(symbol, FROM + d * DAY_MS, manifest));
    verdicts.push(analyseSymbol(symbol, series, FROM));
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`\n§34 H1 (information, all symbols): ${verdicts.every((v) => v.h1) ? 'PASS' : 'FAIL'}; H2 gate (economics, > 4 bps): ${verdicts.every((v) => v.h2) ? 'PASS' : 'FAIL'}`);
}

await main();
