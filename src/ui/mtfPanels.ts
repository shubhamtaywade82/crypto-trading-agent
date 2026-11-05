import chalk from 'chalk';
import stringWidth from 'string-width';
import type { Candle, MarketPriceInfo, Mode, WsStatus } from '../types.js';
import type { MarketState, TrendDirection } from '../market/types.js';
import type { NativeTimeframe } from '../market/MarketDataTypes.js';
import type { MicroFeedHandle } from '../microstructure/MicrostructureFeed.js';
import { formatPrice } from '../binance/symbolRules.js';
import { padLine, priceColor, rule, signedDp } from './format.js';

export interface MtfScreenProps {
  symbols: string[];
  selectedSymbol: string;
  selectedTimeframe: NativeTimeframe;
  marketStates?: Record<string, MarketState>;
  mtfCandles?: Record<string, Partial<Record<NativeTimeframe, Candle[]>>>;
  spotPrices?: Record<string, MarketPriceInfo>;
  microstructure?: MicroFeedHandle;
  funding?: Record<string, number>;
  time: string;
  localTime?: string;
  totalWidth: number;
  totalHeight: number;
  wsStatus: WsStatus;
  mode: Mode;
}

const TF_MS: Record<NativeTimeframe, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const SPARKS = [' ', ' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const shortName = (sym: string) => sym.replace('USDT', '');

function fmtTrend(t?: TrendDirection): string {
  return t === 'BULLISH' ? chalk.green('▲ Bull') : t === 'BEARISH' ? chalk.red('▼ Bear') : chalk.gray('■ Flat');
}

function resolveTfTrend(ms?: MarketState, tf?: NativeTimeframe): TrendDirection {
  if (!ms) return 'NEUTRAL';
  if (tf === '15m') return ms.ltfStructure.trend;
  if (tf === '1h') return ms.htfStructure.trend;
  const s = ms.timeframes?.['4h'];
  return s && s.lastClose > (s.ema50 ?? s.ema20 ?? 0) ? 'BULLISH' : 'BEARISH';
}

function calcConfluence(ms?: MarketState): { score: string; color: typeof chalk.green } {
  if (!ms) return { score: '2/4 MIXED', color: chalk.gray };
  const trends = [ms.ltfStructure.trend, ms.htfStructure.trend, resolveTfTrend(ms, '4h')];
  const bulls = trends.filter((t) => t === 'BULLISH').length;
  const bears = trends.filter((t) => t === 'BEARISH').length;
  if (bulls >= 3) return { score: '3/3 BULLISH', color: chalk.green.bold };
  if (bears >= 3) return { score: '3/3 BEARISH', color: chalk.red.bold };
  return bulls === 2 ? { score: '2/3 BULLISH', color: chalk.green } : bears === 2 ? { score: '2/3 BEARISH', color: chalk.red } : { score: 'MIXED', color: chalk.gray };
}

function calcRelStr(sym: string, prices?: Record<string, MarketPriceInfo>): string {
  if (sym.startsWith('BTC')) return chalk.cyan('0.00% (BASE)');
  const btcChg = prices?.['BTCUSDT']?.changePct ?? prices?.['BTC']?.changePct ?? 0;
  const altChg = prices?.[sym]?.changePct ?? prices?.[shortName(sym)]?.changePct ?? 0;
  const diff = altChg - btcChg;
  if (diff >= 1.5) return chalk.green.bold(`${signedDp(diff)}% (LEADER ⭐)`);
  return diff <= -1.5 ? chalk.red(`${signedDp(diff)}% (LAGGARD)`) : chalk.gray(`${signedDp(diff)}% (IN-LINE)`);
}

export function attachLiveBar(candles: readonly Candle[], livePrice?: number, tf: NativeTimeframe = '15m', now = Date.now()): Candle[] {
  if (!livePrice || !(livePrice > 0)) return [...candles];
  const interval = TF_MS[tf] ?? 900_000;
  const currentOpen = Math.floor(now / interval) * interval;
  const out = [...candles];
  const last = out[out.length - 1];
  if (last && last.openTime === currentOpen) {
    out[out.length - 1] = { ...last, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice), close: livePrice };
  } else if (!last || last.openTime < currentOpen) {
    const prev = last ? last.close : livePrice;
    out.push({ openTime: currentOpen, open: prev, high: Math.max(prev, livePrice), low: Math.min(prev, livePrice), close: livePrice, volume: 0 });
  }
  return out;
}

export function fmtLivePrice(sym: string, tick?: MarketPriceInfo): string {
  if (!tick) return chalk.gray('—'.padStart(11));
  const raw = `$${formatPrice(sym, tick.price)}`;
  if (tick.isFlashing && tick.tickDirection) {
    const arrow = tick.tickDirection === 'UP' ? '▲' : '▼';
    const tag = `${arrow}${raw}`.padStart(11);
    return tick.tickDirection === 'UP' ? chalk.green.bold(tag) : chalk.red.bold(tag);
  }
  const tag = raw.padStart(11);
  return tick.tickDirection === 'UP' ? chalk.green(tag) : tick.tickDirection === 'DOWN' ? chalk.red(tag) : chalk.white(tag);
}

function renderMtfHeader(p: MtfScreenProps, w: number): string[] {
  const wsTag = p.wsStatus === 'connected' ? chalk.green('● LIVE') : chalk.red('○ DOWN');
  const left = ` ⬡ NEMESIS CRYPTO AGENT │ ${chalk.cyan.bold('MTF CANDLES & MARKET ALIGNMENT')} │ ${chalk.white.bold('[Tab] Cockpit')} `;
  const right = `${chalk.yellow.bold(`[${p.mode.toUpperCase()}]`)} ${wsTag} │ ${p.time} UTC ${p.localTime ? `(${p.localTime}) ` : ''}`;
  const midSpace = Math.max(1, w - 2 - stringWidth(left) - stringWidth(right));
  return [
    chalk.cyan('┌' + rule('─', w - 2) + '┐'),
    chalk.cyan('│') + padLine(left + rule(' ', midSpace) + right, w - 2) + chalk.cyan('│'),
    chalk.cyan('├' + rule('─', w - 2) + '┤'),
  ];
}

function renderAnchorCard(w: number, btcState?: MarketState, btcTick?: MarketPriceInfo): string[] {
  const chg = btcTick ? `${signedDp(btcTick.changePct)}%` : '—';
  const chgCol = btcTick && btcTick.changePct >= 0 ? chalk.green : chalk.red;
  const conf = calcConfluence(btcState);
  const l1 = ` ${chalk.yellow.bold('ANCHOR (BTCUSDT)')}  Price: ${fmtLivePrice('BTCUSDT', btcTick)} (${chgCol(chg)})  Regime: ${chalk.cyan.bold(btcState?.regime.regime ?? 'RANGE')}  Confluence: ${conf.color(conf.score)}`;
  const l2 = ` 15m Structure: ${btcState?.ltfStructure.trend ?? 'NEUTRAL'} │ BOS: ${btcState?.ltfStructure.lastBreak?.direction ?? 'NONE'} │ Range: ${btcState?.pricing.premium ? 'PREMIUM' : 'DISCOUNT'}`;
  const l3 = conf.score.includes('BULLISH')
    ? chalk.green(' Filter Status: PERMISSIVE (BTC trend allows Alt Longs)')
    : chalk.yellow(' Filter Status: RESTRICTIVE (BTC choppy or bearish; Alt Longs gatekeeper active)');
  return [
    chalk.cyan('│') + padLine(l1, w - 2) + chalk.cyan('│'),
    chalk.cyan('│') + padLine(l2, w - 2) + chalk.cyan('│'),
    chalk.cyan('│') + padLine(l3, w - 2) + chalk.cyan('│'),
    chalk.cyan('├' + rule('─', w - 2) + '┤'),
  ];
}

function matrixRow(sym: string, p: MtfScreenProps, isSelected: boolean): string {
  const ms = p.marketStates?.[sym] ?? p.marketStates?.[shortName(sym)];
  const tick = p.spotPrices?.[sym] ?? p.spotPrices?.[shortName(sym)];
  const name = isSelected ? chalk.yellow.bold(shortName(sym).padEnd(6)) : chalk.white(shortName(sym).padEnd(6));
  const chg = tick ? signedDp(tick.changePct).padStart(7) + '%' : '—'.padStart(8);
  const chgCol = tick && tick.changePct >= 0 ? chalk.green : chalk.red;
  const trends = `${fmtTrend(resolveTfTrend(ms, '15m'))}  ${fmtTrend(ms?.ltfStructure.trend)}  ${fmtTrend(ms?.htfStructure.trend)}  ${fmtTrend(resolveTfTrend(ms, '4h'))}`;
  const conf = calcConfluence(ms);
  return ` ${isSelected ? chalk.yellow.bold('►') : ' '} ${name} ${fmtLivePrice(sym, tick)}  ${chgCol(chg)}  ${trends}  ${conf.color(conf.score.padEnd(12))}  ${calcRelStr(sym, p.spotPrices)}`;
}

function renderMatrixTable(p: MtfScreenProps, w: number): string[] {
  const header = `   ${chalk.gray('ASSET'.padEnd(6))} ${chalk.gray('PRICE'.padStart(11))}  ${chalk.gray('24h CHG'.padStart(8))}  ${chalk.gray('5m'.padEnd(8))}  ${chalk.gray('15m'.padEnd(8))}  ${chalk.gray('1h'.padEnd(8))}  ${chalk.gray('4h'.padEnd(8))}  ${chalk.gray('CONFLUENCE'.padEnd(12))}  ${chalk.gray('REL STR vs BTC')}`;
  return [
    chalk.cyan('│') + padLine(header, w - 2) + chalk.cyan('│'),
    ...p.symbols.map((sym) => chalk.cyan('│') + padLine(matrixRow(sym, p, sym === p.selectedSymbol), w - 2) + chalk.cyan('│')),
    chalk.cyan('├' + rule('─', w - 2) + '┤'),
  ];
}

function formatCountdown(tf: NativeTimeframe): string {
  const interval = TF_MS[tf] ?? 900_000;
  const rem = interval - (Date.now() % interval);
  const pct = Math.floor(((interval - rem) / interval) * 100);
  const m = Math.floor(rem / 60_000);
  const s = Math.floor((rem % 60_000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} (${pct}%)`;
}

function buildChartRow(candles: Candle[], ctx: { r: number; height: number; minP: number; span: number; liveRow: number }): string {
  const pTop = ctx.minP + ctx.span - (ctx.r / (ctx.height - 1)) * ctx.span;
  const pBot = ctx.minP + ctx.span - ((ctx.r + 1) / (ctx.height - 1)) * ctx.span;
  let rowStr = '';
  for (const c of candles) {
    if (Math.max(c.open, c.close) >= pBot && Math.min(c.open, c.close) <= pTop) {
      rowStr += c.close >= c.open ? chalk.green(' █ ') : chalk.red(' █ ');
    } else if (c.high >= pBot && c.low <= pTop) {
      rowStr += chalk.gray(' │ ');
    } else {
      rowStr += ctx.r === ctx.liveRow ? chalk.gray(' ┄ ') : '   ';
    }
  }
  return rowStr;
}

function formatPriceLabel(sym: string, pVal: number, isLive: boolean, tick?: MarketPriceInfo): string {
  if (isLive && tick) {
    const tag = `►$${formatPrice(sym, tick.price)}`.padStart(11);
    const flashCol = tick.tickDirection === 'UP' ? chalk.green.bold : chalk.red.bold;
    return (tick.isFlashing && tick.tickDirection ? flashCol(tag) : chalk.yellow.bold(tag)) + ' │';
  }
  return `$${formatPrice(sym, pVal)}`.padStart(11) + ' │';
}

function renderVolumeRow(slice: Candle[], w: number): string {
  const maxVol = Math.max(1, ...slice.map((c) => c.volume));
  let volStr = '';
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i]!;
    const idx = Math.min(SPARKS.length - 1, Math.floor((c.volume / maxVol) * (SPARKS.length - 1)));
    const col = i === slice.length - 1 ? chalk.cyan.bold : c.close >= c.open ? chalk.green : chalk.red;
    volStr += col(` ${SPARKS[idx]} `);
  }
  return chalk.cyan('│') + padLine(` ${chalk.gray('Volume     │')}${volStr}`, w - 2) + chalk.cyan('│');
}

interface ChartOptions {
  sym: string;
  tf: NativeTimeframe;
  width: number;
  height: number;
  livePrice?: number;
  tick?: MarketPriceInfo;
}

function renderAsciiCandleChart(candles: Candle[], opts: ChartOptions): string[] {
  const { sym, tf, width, height, livePrice, tick } = opts;
  if (candles.length === 0) {
    const empty = Array.from({ length: height }, (_, r) =>
      chalk.cyan('│') + padLine(r === Math.floor(height / 2) ? ` No ${tf} candle history available for ${sym}` : '', width - 2) + chalk.cyan('│')
    );
    return [...empty, chalk.cyan('│') + padLine(' ' + chalk.gray('Volume     │ —'), width - 2) + chalk.cyan('│')];
  }
  const slice = candles.slice(-Math.max(6, Math.floor((width - 18) / 3)));
  const minP = Math.min(...slice.map((c) => c.low));
  const maxP = Math.max(...slice.map((c) => c.high));
  const span = Math.max(0.0001, maxP - minP);
  const liveRow = livePrice && livePrice >= minP && livePrice <= maxP ? Math.round(((maxP - livePrice) / span) * (height - 1)) : -1;

  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const pVal = maxP - (r / (height - 1)) * span;
    const isMajor = r === 0 || r === Math.floor(height / 2) || r === height - 1;
    const isQuarter = height >= 16 && (r === Math.floor(height / 4) || r === Math.floor((3 * height) / 4));
    const label = r === liveRow
      ? formatPriceLabel(sym, pVal, true, tick)
      : (isMajor || isQuarter) ? chalk.gray(formatPriceLabel(sym, pVal, false)) : chalk.gray(' '.repeat(11) + ' │');
    lines.push(chalk.cyan('│') + padLine(` ${label}${buildChartRow(slice, { r, height, minP, span, liveRow })}`, width - 2) + chalk.cyan('│'));
  }
  lines.push(renderVolumeRow(slice, width));
  return lines;
}

function renderMicroFooter(p: MtfScreenProps, w: number): string[] {
  const sym = p.selectedSymbol;
  const tf = p.selectedTimeframe;
  const ms = p.marketStates?.[sym] ?? p.marketStates?.[shortName(sym)];
  const tfTabs = ['5m', '15m', '1h', '4h'].map((t) => (t === tf ? chalk.yellow.bold(`[${t}*]`) : chalk.gray(`[${t}]`))).join(' ');
  const mv = p.microstructure?.view(sym, 10, 10);
  const spread = mv?.reading?.spreadBps ?? ms?.derivatives?.spreadBps;
  const cvd = mv?.reading?.flow?.cvd;
  const cvdStr = cvd !== undefined && Number.isFinite(cvd) ? ` │ CVD: ${cvd >= 0 ? chalk.green('+' + cvd.toFixed(1)) : chalk.red(cvd.toFixed(1))}` : '';
  const l1 = ` ${chalk.yellow.bold(sym)} Timeframe: ${tfTabs} │ Next candle closes in: ${chalk.white.bold(formatCountdown(tf))} │ Spread: ${spread != null ? spread.toFixed(1) : '—'} bps${cvdStr}`;
  const l2 = ` SMC: BOS ${ms?.ltfStructure.lastBreak?.direction ?? 'NONE'} │ Sweeps: ${ms?.liquidity.ltf.latestSweeps[0]?.direction ?? 'NONE'} │ Volatility: ${ms?.regime.volatility ?? 'NORMAL'}`;
  return [
    chalk.cyan('│') + padLine(l1, w - 2) + chalk.cyan('│'),
    chalk.cyan('│') + padLine(l2, w - 2) + chalk.cyan('│'),
    chalk.cyan('├' + rule('─', w - 2) + '┤'),
  ];
}

function renderMtfFooter(w: number): string[] {
  const keys = ' [Tab/m] Cockpit View │ [↑/↓] Select Asset │ [←/→] Change TF │ [k] Kill-Switch │ [c] Close Pos │ [s] Exit';
  return [chalk.cyan('│') + padLine(chalk.gray(keys), w - 2) + chalk.cyan('│'), chalk.cyan('└' + rule('─', w - 2) + '┘')];
}

export function renderMtfScreen(p: MtfScreenProps): string[] {
  const w = Math.max(100, p.totalWidth);
  const btcTick = p.spotPrices?.['BTCUSDT'] ?? p.spotPrices?.['BTC'];
  const tick = p.spotPrices?.[p.selectedSymbol] ?? p.spotPrices?.[shortName(p.selectedSymbol)];
  const rawCandles = p.mtfCandles?.[p.selectedSymbol]?.[p.selectedTimeframe] ?? [];
  const candles = attachLiveBar(rawCandles, tick?.price, p.selectedTimeframe);

  const chartHeight = Math.max(8, (p.totalHeight ?? 30) - 1 - (15 + p.symbols.length));

  return [
    ...renderMtfHeader(p, w),
    ...renderAnchorCard(w, p.marketStates?.['BTCUSDT'] ?? p.marketStates?.['BTC'], btcTick),
    ...renderMatrixTable(p, w),
    ...renderMicroFooter(p, w),
    ...renderAsciiCandleChart(candles, { sym: p.selectedSymbol, tf: p.selectedTimeframe, width: w, height: chartHeight, livePrice: tick?.price, tick }),
    ...renderMtfFooter(w),
  ];
}
