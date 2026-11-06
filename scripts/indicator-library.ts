import type { Bar } from './indicator-matrix-scanner.js';

export interface IndicatorSet {
  closes: number[];
  highs: number[];
  lows: number[];
  ema9: Float64Array;
  ema20: Float64Array;
  ema50: Float64Array;
  ema200: Float64Array;
  atr14: Float64Array;
  rsi14: Float64Array;
  stochK: Float64Array;
  stochD: Float64Array;
  macd: Float64Array;
  macdSig: Float64Array;
  bbWidth: Float64Array;
  isSqueeze: Uint8Array;
  donchianHigh20: Float64Array;
  donchianLow20: Float64Array;
  supertrend: Float64Array;
  supertrendDir: Int8Array; // 1 bull, -1 bear
  adx14: Float64Array;
  volSma20: Float64Array;
  takerRatio: Float64Array;
}

export function calcEma(values: number[], period: number): Float64Array {
  const n = values.length, out = new Float64Array(n), k = 2 / (period + 1);
  let sum = 0; for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function calcAtr(highs: number[], lows: number[], closes: number[], period = 14): Float64Array {
  const n = closes.length, tr = new Float64Array(n), atr = new Float64Array(n);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  let sum = 0; for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

export function calcRsi(closes: number[], period = 14): Float64Array {
  const n = closes.length, out = new Float64Array(n);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l += -d;
  }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  }
  return out;
}

function calcStoch(highs: number[], lows: number[], closes: number[], period = 14) {
  const n = closes.length, k = new Float64Array(n), d = new Float64Array(n);
  for (let i = period - 1; i < n; i++) {
    let maxH = -Infinity, minL = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > maxH) maxH = highs[j];
      if (lows[j] < minL) minL = lows[j];
    }
    k[i] = maxH === minL ? 50 : ((closes[i] - minL) / (maxH - minL)) * 100;
  }
  for (let i = period + 1; i < n; i++) d[i] = (k[i] + k[i - 1] + k[i - 2]) / 3;
  return { k, d };
}

function calcSupertrend(highs: number[], lows: number[], closes: number[], atr: Float64Array, mult = 2.0) {
  const n = closes.length, st = new Float64Array(n), dir = new Int8Array(n);
  let upper = (highs[0] + lows[0]) / 2 + mult * atr[0];
  let lower = (highs[0] + lows[0]) / 2 - mult * atr[0];
  dir[0] = 1; st[0] = lower;

  for (let i = 1; i < n; i++) {
    const mid = (highs[i] + lows[i]) / 2, basicUpper = mid + mult * atr[i], basicLower = mid - mult * atr[i];
    upper = (basicUpper < upper || closes[i - 1] > upper) ? basicUpper : upper;
    lower = (basicLower > lower || closes[i - 1] < lower) ? basicLower : lower;
    if (dir[i - 1] === 1) {
      dir[i] = closes[i] < lower ? -1 : 1;
      st[i] = dir[i] === 1 ? lower : upper;
    } else {
      dir[i] = closes[i] > upper ? 1 : -1;
      st[i] = dir[i] === 1 ? lower : upper;
    }
  }
  return { st, dir };
}

function calcAdx(highs: number[], lows: number[], closes: number[], period = 14): Float64Array {
  const n = closes.length, adx = new Float64Array(n), tr = new Float64Array(n), pdm = new Float64Array(n), mdm = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    pdm[i] = (up > down && up > 0) ? up : 0;
    mdm[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  let sTr = 0, sPdm = 0, sMdm = 0;
  for (let i = 1; i <= period; i++) { sTr += tr[i]; sPdm += pdm[i]; sMdm += mdm[i]; }
  const dx = new Float64Array(n);
  for (let i = period + 1; i < n; i++) {
    sTr = sTr - (sTr / period) + tr[i];
    sPdm = sPdm - (sPdm / period) + pdm[i];
    sMdm = sMdm - (sMdm / period) + mdm[i];
    const pdi = (sPdm / sTr) * 100, mdi = (sMdm / sTr) * 100;
    dx[i] = (pdi + mdi === 0) ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
  }
  let sDx = 0; for (let i = period + 1; i <= 2 * period; i++) sDx += dx[i];
  adx[2 * period] = sDx / period;
  for (let i = 2 * period + 1; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return adx;
}

export function buildIndicators(bars: Bar[]): IndicatorSet {
  const n = bars.length, closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const ema9 = calcEma(closes, 9), ema20 = calcEma(closes, 20), ema50 = calcEma(closes, 50), ema200 = calcEma(closes, 200);
  const atr14 = calcAtr(highs, lows, closes, 14), rsi14 = calcRsi(closes, 14);
  const { k: stochK, d: stochD } = calcStoch(highs, lows, closes, 14);

  const mFast = calcEma(closes, 12), mSlow = calcEma(closes, 26), macd = new Float64Array(n);
  for (let i = 25; i < n; i++) macd[i] = mFast[i] - mSlow[i];
  const macdSig = calcEma(Array.from(macd), 9);

  const bbWidth = new Float64Array(n), isSqueeze = new Uint8Array(n);
  const donchianHigh20 = new Float64Array(n), donchianLow20 = new Float64Array(n);
  for (let i = 19; i < n; i++) {
    let m = 0; for (let k = i - 19; k <= i; k++) m += closes[k]; m /= 20;
    let v = 0; for (let k = i - 19; k <= i; k++) v += (closes[k] - m) ** 2;
    const sd = Math.sqrt(v / 20);
    bbWidth[i] = (4 * sd) / m;
    // TTM Squeeze check: Bollinger Band inside 1.5 ATR Keltner Channel
    const kcSpan = 1.5 * atr14[i];
    isSqueeze[i] = (sd * 2 <= kcSpan) ? 1 : 0;

    let maxH = -Infinity, minL = Infinity;
    for (let k = i - 19; k <= i; k++) {
      if (highs[k] > maxH) maxH = highs[k];
      if (lows[k] < minL) minL = lows[k];
    }
    donchianHigh20[i] = maxH; donchianLow20[i] = minL;
  }

  const { st: supertrend, dir: supertrendDir } = calcSupertrend(highs, lows, closes, atr14, 2.0);
  const adx14 = calcAdx(highs, lows, closes, 14);

  const volSma20 = new Float64Array(n), takerRatio = new Float64Array(n);
  let vSum = 0;
  for (let i = 0; i < n; i++) {
    vSum += bars[i].volume;
    if (i >= 20) vSum -= bars[i - 20].volume;
    if (i >= 19) volSma20[i] = vSum / 20;
    takerRatio[i] = bars[i].volume > 0 ? bars[i].takerBuyVolume / bars[i].volume : 0.5;
  }

  return {
    closes, highs, lows, ema9, ema20, ema50, ema200, atr14, rsi14,
    stochK, stochD, macd, macdSig, bbWidth, isSqueeze,
    donchianHigh20, donchianLow20, supertrend, supertrendDir, adx14, volSma20, takerRatio
  };
}
