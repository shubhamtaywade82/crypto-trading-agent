/**
 * §34 OFI Stage A statistics on per-second records. Every predictor is causal (windows end at the decision second); labels are the
 * mid move t → t + h in bps, signed in the predictor's direction. Decile edges come from days 1–15 of each month, tests from the rest.
 */
export const SECONDS = 86_400;
/** Per-second record: [last mid, sum spread bps, OFI, book updates, aggressor-buy quote, aggressor-sell quote]. */
export const FIELDS = 6;
export const HORIZONS = [1, 2, 5, 10, 15, 30];
const WINDOW = 10;
const NORM_WINDOW = 3_600;
const VOL_WINDOW = 60;
const H2_BPS = 4;
const BOOT = 2_000;
const DAY_MS = 86_400_000;

interface Columns { mid: Float64Array; ofi: Float64Array; spread: Float64Array; delta: Float64Array }
/** One row per evaluated second. Predictor values are signed; `fwd[h][i]` is the raw (unsigned) forward move in bps. */
export interface Samples { ofi: Float32Array; delta: Float32Array; mom: Float32Array; spread: Float32Array; vol: Float32Array; day: Int16Array; second: Int32Array; fwd: Float32Array[]; n: number }

function columns(series: Float64Array[]): Columns {
  const n = series.length * SECONDS;
  const c: Columns = { mid: new Float64Array(n), ofi: new Float64Array(n), spread: new Float64Array(n), delta: new Float64Array(n) };
  let mid = NaN; let spread = NaN;
  for (let i = 0; i < n; i += 1) {
    const r = series[Math.floor(i / SECONDS)]!; const o = (i % SECONDS) * FIELDS;
    if (Number.isFinite(r[o]!)) mid = r[o]!;
    if (r[o + 3]! > 0) spread = r[o + 1]! / r[o + 3]!;
    c.mid[i] = mid; c.spread[i] = spread; c.ofi[i] = r[o + 2]!; c.delta[i] = r[o + 4]! - r[o + 5]!;
  }
  return c;
}

/** Causal z-score of the trailing WINDOW-second sum, scaled by the RMS of that sum over the previous hour. */
function trailingZ(x: Float64Array): Float64Array {
  const n = x.length; const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) cum[i + 1] = cum[i]! + x[i]!;
  const win = (i: number): number => cum[i + 1]! - cum[i + 1 - WINDOW]!;
  const z = new Float64Array(n).fill(NaN);
  let sumSq = 0;
  for (let i = WINDOW; i < n; i += 1) {
    sumSq += win(i - 1) ** 2;
    if (i - 1 - NORM_WINDOW >= WINDOW) sumSq -= win(i - 1 - NORM_WINDOW) ** 2;
    if (i >= NORM_WINDOW + WINDOW) z[i] = win(i) / Math.sqrt(sumSq / NORM_WINDOW);
  }
  return z;
}

function realisedVol(mid: Float64Array, i: number): number {
  let sum = 0; let sumSq = 0;
  for (let k = i - VOL_WINDOW + 1; k <= i; k += 1) { const r = (mid[k]! / mid[k - 1]! - 1) * 1e4; sum += r; sumSq += r * r; }
  return Math.sqrt(Math.max(0, sumSq / VOL_WINDOW - (sum / VOL_WINDOW) ** 2));
}

export function buildSamples(series: Float64Array[]): Samples {
  const c = columns(series); const n = c.mid.length; const maxH = Math.max(...HORIZONS);
  const oz = trailingZ(c.ofi); const dz = trailingZ(c.delta);
  const keep: number[] = [];
  for (let i = NORM_WINDOW + WINDOW; i < n - maxH; i += 1) if (Number.isFinite(oz[i]!) && Number.isFinite(dz[i]!) && Number.isFinite(c.mid[i - VOL_WINDOW]!) && oz[i] !== 0) keep.push(i);
  const m = keep.length; const f32 = (): Float32Array => new Float32Array(m);
  const s: Samples = { ofi: f32(), delta: f32(), mom: f32(), spread: f32(), vol: f32(), day: new Int16Array(m), second: new Int32Array(m), fwd: HORIZONS.map(f32), n: m };
  keep.forEach((i, j) => {
    s.ofi[j] = oz[i]!; s.delta[j] = dz[i]!; s.mom[j] = (c.mid[i]! / c.mid[i - WINDOW]! - 1) * 1e4;
    s.spread[j] = c.spread[i]!; s.vol[j] = realisedVol(c.mid, i); s.day[j] = Math.floor(i / SECONDS); s.second[j] = i % SECONDS;
    HORIZONS.forEach((h, k) => { s.fwd[k]![j] = (c.mid[i + h]! / c.mid[i]! - 1) * 1e4; });
  });
  return s;
}

const mean = (xs: ArrayLike<number>): number => { let t = 0; for (let i = 0; i < xs.length; i += 1) t += xs[i]!; return xs.length ? t / xs.length : NaN; };
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? NaN; };

/** One-sided 90% lower bound of the mean, resampling whole UTC days (adjacent seconds are not independent). */
function dayBlockLcb(values: number[], days: number[]): number {
  const sums = new Map<number, [number, number]>();
  values.forEach((v, i) => { const a = sums.get(days[i]!) ?? [0, 0]; a[0] += v; a[1] += 1; sums.set(days[i]!, a); });
  const blocks = [...sums.values()]; let seed = 12345;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const means: number[] = [];
  for (let b = 0; b < BOOT; b += 1) {
    let total = 0; let count = 0;
    for (let k = 0; k < blocks.length; k += 1) { const blk = blocks[Math.floor(rand() * blocks.length)]!; total += blk[0]; count += blk[1]; }
    means.push(total / count);
  }
  return means.sort((a, b) => a - b)[Math.floor(0.1 * BOOT)]!;
}

function spearman10(values: number[]): number {
  const ranks = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map(([, i], r) => [i, r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  return 1 - (6 * ranks.reduce((s, r, i) => s + (r - i) ** 2, 0)) / (10 * (100 - 1));
}

/** Decile index (0–9) of |x| for every test sample, with edges from the calibration days of the same month. */
function deciles(predictor: Float32Array, s: Samples, isCalibration: (day: number) => boolean, monthOf: (day: number) => number): Int8Array {
  const edgesByMonth = new Map<number, number[]>();
  const calibration = new Map<number, number[]>();
  for (let i = 0; i < s.n; i += 1) if (isCalibration(s.day[i]!)) { const m = monthOf(s.day[i]!); (calibration.get(m) ?? calibration.set(m, []).get(m)!).push(Math.abs(predictor[i]!)); }
  for (const [m, xs] of calibration) { xs.sort((a, b) => a - b); edgesByMonth.set(m, Array.from({ length: 9 }, (_, k) => xs[Math.floor(((k + 1) / 10) * xs.length)]!)); }
  const out = new Int8Array(s.n).fill(-1);
  for (let i = 0; i < s.n; i += 1) {
    const edges = edgesByMonth.get(monthOf(s.day[i]!));
    if (!edges || isCalibration(s.day[i]!)) continue;
    const a = Math.abs(predictor[i]!); let d = 0;
    while (d < 9 && a >= edges[d]!) d += 1;
    out[i] = d;
  }
  return out;
}

interface Row { meanByDecile: number[]; medianTop: number; lcbTop: number; spearman: number; longTop: number; shortTop: number }

function profile(predictor: Float32Array, s: Samples, dec: Int8Array, k: number): Row {
  const byDecile = Array.from({ length: 10 }, () => [] as number[]);
  const top: number[] = []; const topDays: number[] = []; const longs: number[] = []; const shorts: number[] = [];
  for (let i = 0; i < s.n; i += 1) {
    if (dec[i]! < 0) continue;
    const signed = Math.sign(predictor[i]!) * s.fwd[k]![i]!;
    byDecile[dec[i]!]!.push(signed);
    if (dec[i] === 9) { top.push(signed); topDays.push(s.day[i]!); (predictor[i]! > 0 ? longs : shorts).push(signed); }
  }
  const meanByDecile = byDecile.map(mean);
  return { meanByDecile, medianTop: median(top), lcbTop: dayBlockLcb(top, topDays), spearman: spearman10(meanByDecile), longTop: mean(longs), shortTop: mean(shorts) };
}

/** Top-OFI-decile signed move split by a condition into three groups (terciles of `by` among those samples). */
function conditioned(s: Samples, dec: Int8Array, k: number, by: (i: number) => number): number[] {
  const idx: number[] = []; for (let i = 0; i < s.n; i += 1) if (dec[i] === 9) idx.push(i);
  const values = idx.map(by).sort((a, b) => a - b);
  const cuts = [values[Math.floor(values.length / 3)]!, values[Math.floor((2 * values.length) / 3)]!];
  const groups: number[][] = [[], [], []];
  for (const i of idx) { const v = by(i); groups[v < cuts[0]! ? 0 : v < cuts[1]! ? 1 : 2]!.push(Math.sign(s.ofi[i]!) * s.fwd[k]![i]!); }
  return groups.map(mean);
}

const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

function sessionLine(s: Samples, dec: Int8Array, k: number): string {
  const groups: number[][] = [[], [], []];
  for (let i = 0; i < s.n; i += 1) if (dec[i] === 9) groups[Math.floor(s.second[i]! / 28_800)]!.push(Math.sign(s.ofi[i]!) * s.fwd[k]![i]!);
  return groups.map((g, j) => `${['00-08', '08-16', '16-24'][j]} ${f(mean(g))}`).join(' ');
}

/** Prints the §34 tables for one symbol and returns its H1/H2 verdicts. */
export function analyseSymbol(symbol: string, series: Float64Array[], from: number): { h1: boolean; h2: boolean } {
  const s = buildSamples(series);
  const date = (day: number): Date => new Date(from + day * DAY_MS);
  const isCalibration = (day: number): boolean => date(day).getUTCDate() <= 15;
  const monthOf = (day: number): number => date(day).getUTCMonth();
  const dOfi = deciles(s.ofi, s, isCalibration, monthOf); const dMom = deciles(s.mom, s, isCalibration, monthOf);
  const spreads = Array.from(s.spread).filter(Number.isFinite);
  console.log(`\n== ${symbol}: ${s.n} seconds (test = days 16+ of each month), mean spread ${f(mean(spreads))} bps`);
  let informative = 0; let economic = false; let beyondMomentum = true;
  HORIZONS.forEach((h, k) => {
    const o = profile(s.ofi, s, dOfi, k); const m = profile(s.mom, s, dMom, k);
    const momTerciles = conditioned(s, dOfi, k, (i) => Math.sign(s.ofi[i]!) * s.mom[i]!);
    const pass = o.meanByDecile[9]! > 0 && o.lcbTop > 0 && o.spearman >= 0.8;
    if (pass) { informative += 1; if (!momTerciles.every((x) => x > 0)) beyondMomentum = false; }
    if (o.meanByDecile[9]! > H2_BPS && o.lcbTop > H2_BPS) economic = true;
    console.log(`  h=${String(h).padStart(2)}s OFI deciles ${o.meanByDecile.map(f).join(' ')} | top mean ${f(o.meanByDecile[9]!)} median ${f(o.medianTop)} LCB90 ${f(o.lcbTop)} spearman ${o.spearman.toFixed(2)} long ${f(o.longTop)} short ${f(o.shortTop)}`);
    console.log(`         momentum-only top ${f(m.meanByDecile[9]!)} (LCB ${f(m.lcbTop)}) | OFI top by momentum tercile (against/neutral/with) ${momTerciles.map(f).join(' / ')}`);
    console.log(`         OFI top by trade-delta tercile (against/neutral/with) ${conditioned(s, dOfi, k, (i) => Math.sign(s.ofi[i]!) * s.delta[i]!).map(f).join(' / ')} | by spread tercile ${conditioned(s, dOfi, k, (i) => s.spread[i]!).map(f).join(' / ')} | by vol tercile ${conditioned(s, dOfi, k, (i) => s.vol[i]!).map(f).join(' / ')} | sessions ${sessionLine(s, dOfi, k)}`);
  });
  const h1 = informative >= 3 && beyondMomentum;
  console.log(`  ${symbol}: H1 ${h1 ? 'PASS' : 'FAIL'} (${informative} horizons informative, beyond momentum ${beyondMomentum}); H2 ${economic ? 'PASS' : 'FAIL'} (top decile > ${H2_BPS} bps with LCB > ${H2_BPS})`);
  return { h1, h2: economic };
}
