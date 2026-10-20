import chalk from 'chalk';
import type { Candle, MarketPriceInfo, Mode, WsStatus } from '../types.js';
import type { MarketState, Timeframe, TrendDirection } from '../market/types.js';
import type { NativeTimeframe } from '../market/MarketDataTypes.js';
import { formatPrice } from '../binance/symbolRules.js';
import { fmtVol, padLine, rule, signedDp } from './format.js';

export interface MtfScreenProps {
  symbols: string[];
  selectedSymbol: string;
  selectedTimeframe: NativeTimeframe;
  marketStates?: Record<string, MarketState>;
  mtfCandles?: Record<string, Partial<Record<NativeTimeframe, Candle[]>>>;
  spotPrices?: Record<string, MarketPriceInfo>;
  funding?: Record<string, number>;
  time: string;
  localTime?: string;
  totalWidth: number;
  totalHeight: number;
  wsStatus: WsStatus;
  mode: Mode;
}

const TF_MS: Record<NativeTimeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

const SPARKS = [' ', ' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const shortName = (sym: string) => sym.replace('USDT', '');

function fmtTrend(t?: TrendDirection): string {
  if (t === 'BULLISH') return chalk.green('▲ Bull');
  if (t === 'BEARISH') return chalk.red('▼ Bear');
  return chalk.gray('■ Flat');
}

function resolveTfTrend(ms?: MarketState, tf?: NativeTimeframe): TrendDirection {
  if (!ms) return 'NEUTRAL';
  if (tf === '15m') return ms.ltfStructure.trend;
  if (tf === '1h') return ms.htfStructure.trend;
  if (tf === '4h') {
    const s = ms.timeframes?.['4h'];
    if (!s || s.lastClose <= 0) return 'NEUTRAL';
    const base = s.ema50 ?? s.ema20;
    return base && s.lastClose > base ? 'BULLISH' : 'BEARISH';
  }
  return 'NEUTRAL';
}

function calcConfluence(ms?: MarketState): { score: string; color: typeof chalk.green } {
  if (!ms) return { score: '2/4 MIXED', color: chalk.gray };
  const trends = [ms.ltfStructure.trend, ms.htfStructure.trend, resolveTfTrend(ms, '4h')];
  const bulls = trends.filter((t) => t === 'BULLISH').length;
  const bears = trends.filter((t) => t === 'BEARISH').length;
  if (bulls >= 3) return { score: '3/3 BULLISH', color: chalk.green.bold };
  if (bears >= 3) return { score: '3/3 BEARISH', color: chalk.red.bold };
  if (bulls === 2) return { score: '2/3 BULLISH', color: chalk.green };
  if (bears === 2) return { score: '2/3 BEARISH', color: chalk.red };
  return { score: 'MIXED', color: chalk.gray };
}

function calcRelStr(sym: string, prices?: Record<string, MarketPriceInfo>): string {
  if (sym.startsWith('BTC')) return chalk.cyan('0.00% (BASE)');
  const btcChg = prices?.['BTCUSDT']?.changePct ?? prices?.['BTC']?.changePct ?? 0;
  const altChg = prices?.[sym]?.changePct ?? prices?.[shortName(sym)]?.changePct ?? 0;
  const diff = altChg - btcChg;
  if (diff >= 1.5) return chalk.green.bold(`${signedDp(diff)}% (LEADER ⭐)`);
  if (diff <= -1.5) return chalk.red(`${signedDp(diff)}% (LAGGARD)`);
  return chalk.gray(`${signedDp(diff)}% (IN-LINE)`);
}

function renderMtfHeader(p: MtfScreenProps, w: number): string[] {
  const wsTag = p.wsStatus === 'connected' ? chalk.green('● LIVE') : chalk.red('○ DOWN');
  const modeTag = chalk.yellow.bold(`[${p.mode.toUpperCase()}]`);
  const left = ` ⬡ INKUI AGENT TRADE │ ${chalk.cyan.bold('MTF CANDLES & MARKET ALIGNMENT')} │ ${chalk.white.bold('[Tab] Cockpit')} `;
  const right = `${modeTag} ${wsTag} │ ${p.time} UTC ${p.localTime ? `(${p.localTime}) ` : ''}`;
  const gap = Math.max(1, w - 2 - chalk.reset(left).length - chalk.reset(right).length);
  return [
    chalk.cyan('┌' + rule('─', w - 2) + '┐'),
    chalk.cyan('│') + left + ' '.repeat(gap) + right + chalk.cyan('│'),
    chalk.cyan('├' + rule('─', w - 2) + '┤'),
  ];
}

function renderAnchorCard(w: number, btcState?: MarketState, btcTick?: MarketPriceInfo): string[] {
  const price = btcTick ? `$${formatPrice('BTCUSDT', btcTick.price)}` : '—';
  const chg = btcTick ? `${signedDp(btcTick.changePct)}%` : '—';
  const chgCol = btcTick && btcTick.changePct >= 0 ? chalk.green : chalk.red;
  const reg = btcState?.regime.regime ?? 'RANGE';
  const conf = calcConfluence(btcState);

  const l1 = ` ${chalk.yellow.bold('ANCHOR (BTCUSDT)')}  Price: ${chalk.white.bold(price)} (${chgCol(chg)})  Regime: ${chalk.cyan.bold(reg)}  Confluence: ${conf.color(conf.score)}`;
  const l2 = ` 15m Structure: ${btcState?.ltfStructure.trend ?? 'NEUTRAL'} │ BOS: ${btcState?.ltfStructure.lastBreak ? btcState.ltfStructure.lastBreak.direction : 'NONE'} │ Range: ${btcState?.pricing.premium ? 'PREMIUM' : 'DISCOUNT'}`;
  const allowLong = conf.score.includes('BULLISH');
  const l3 = allowLong
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
  const cur = isSelected ? chalk.yellow.bold('►') : ' ';
  const name = isSelected ? chalk.yellow.bold(shortName(sym).padEnd(6)) : chalk.white(shortName(sym).padEnd(6));
  const px = (tick ? `$${formatPrice(sym, tick.price)}` : '—').padStart(11);
  const chg = tick ? signedDp(tick.changePct).padStart(7) + '%' : '—'.padStart(8);
  const chgCol = tick && tick.changePct >= 0 ? chalk.green : chalk.red;

  const t5 = fmtTrend(resolveTfTrend(ms, '15m'));
  const t15 = fmtTrend(ms?.ltfStructure.trend);
  const t1h = fmtTrend(ms?.htfStructure.trend);
  const t4h = fmtTrend(resolveTfTrend(ms, '4h'));
  const conf = calcConfluence(ms);
  const rel = calcRelStr(sym, p.spotPrices);

  return ` ${cur} ${name} ${px}  ${chgCol(chg)}  ${t5}  ${t15}  ${t1h}  ${t4h}  ${conf.color(conf.score.padEnd(12))}  ${rel}`;
}

function renderMatrixTable(p: MtfScreenProps, w: number): string[] {
  const header = `   ${chalk.gray('ASSET'.padEnd(6))} ${chalk.gray('PRICE'.padStart(11))}  ${chalk.gray('24h CHG'.padStart(8))}  ${chalk.gray('5m'.padEnd(8))}  ${chalk.gray('15m'.padEnd(8))}  ${chalk.gray('1h'.padEnd(8))}  ${chalk.gray('4h'.padEnd(8))}  ${chalk.gray('CONFLUENCE'.padEnd(12))}  ${chalk.gray('REL STR vs BTC')}`;
  const lines = [chalk.cyan('│') + padLine(header, w - 2) + chalk.cyan('│')];
  for (const sym of p.symbols) {
    const isSel = sym === p.selectedSymbol;
    lines.push(chalk.cyan('│') + padLine(matrixRow(sym, p, isSel), w - 2) + chalk.cyan('│'));
  }
  lines.push(chalk.cyan('├' + rule('─', w - 2) + '┤'));
  return lines;
}

function formatCountdown(tf: NativeTimeframe): string {
  const interval = TF_MS[tf];
  const rem = interval - (Date.now() % interval);
  const m = Math.floor(rem / 60_000);
  const s = Math.floor((rem % 60_000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildChartRow(candles: Candle[], r: number, rows: number, minP: number, span: number): string {
  const pTop = minP + span - (r / (rows - 1)) * span;
  const pBot = minP + span - ((r + 1) / (rows - 1)) * span;

  let rowStr = '';
  for (const c of candles) {
    const bTop = Math.max(c.open, c.close);
    const bBot = Math.min(c.open, c.close);
    const isBull = c.close >= c.open;

    if (bTop >= pBot && bBot <= pTop) {
      rowStr += isBull ? chalk.green(' █ ') : chalk.red(' █ ');
    } else if (c.high >= pBot && c.low <= pTop) {
      rowStr += chalk.gray(' │ ');
    } else {
      rowStr += '   ';
    }
  }
  return rowStr;
}

function renderAsciiCandleChart(candles: Candle[], sym: string, tf: NativeTimeframe, w: number, h = 9): string[] {
  if (candles.length === 0) {
    return [chalk.cyan('│') + padLine(` No ${tf} candle history available for ${sym}`, w - 2) + chalk.cyan('│')];
  }
  const maxBars = Math.max(6, Math.floor((w - 18) / 3));
  const slice = candles.slice(-maxBars);
  const minP = Math.min(...slice.map((c) => c.low));
  const maxP = Math.max(...slice.map((c) => c.high));
  const span = Math.max(0.0001, maxP - minP);

  const lines: string[] = [];
  for (let r = 0; r < h; r++) {
    const pVal = maxP - (r / (h - 1)) * span;
    const label = (r === 0 || r === Math.floor(h / 2) || r === h - 1)
      ? `$${formatPrice(sym, pVal)}`.padStart(11) + ' │'
      : ' '.repeat(11) + ' │';
    const body = buildChartRow(slice, r, h, minP, span);
    lines.push(chalk.cyan('│') + padLine(` ${chalk.gray(label)}${body}`, w - 2) + chalk.cyan('│'));
  }

  // Volume row
  const maxVol = Math.max(1, ...slice.map((c) => c.volume));
  let volStr = '';
  for (const c of slice) {
    const idx = Math.min(SPARKS.length - 1, Math.floor((c.volume / maxVol) * (SPARKS.length - 1)));
    const sp = SPARKS[idx];
    volStr += c.close >= c.open ? chalk.green(` ${sp} `) : chalk.red(` ${sp} `);
  }
  lines.push(chalk.cyan('│') + padLine(` ${chalk.gray('Volume     │')}${volStr}`, w - 2) + chalk.cyan('│'));

  return lines;
}

function renderMicroFooter(sym: string, tf: NativeTimeframe, w: number, ms?: MarketState): string[] {
  const cd = formatCountdown(tf);
  const tfTabs = ['5m', '15m', '1h', '4h']
    .map((t) => (t === tf ? chalk.yellow.bold(`[${t}*]`) : chalk.gray(`[${t}]`)))
    .join(' ');
  const l1 = ` ${chalk.yellow.bold(sym)} Timeframe: ${tfTabs} │ Next candle closes in: ${chalk.white.bold(cd)} │ Spread: ${ms?.derivatives?.spreadBps?.toFixed(1) ?? '—'} bps`;
  const l2 = ` SMC: BOS ${ms?.ltfStructure.lastBreak?.direction ?? 'NONE'} │ Sweeps: ${ms?.liquidity.ltf.latestSweeps[0]?.direction ?? 'NONE'} │ Volatility: ${ms?.regime.volatility ?? 'NORMAL'}`;

  return [
    chalk.cyan('│') + padLine(l1, w - 2) + chalk.cyan('│'),
    chalk.cyan('│') + padLine(l2, w - 2) + chalk.cyan('│'),
    chalk.cyan('├' + rule('─', w - 2) + '┤'),
  ];
}

function renderMtfFooter(w: number): string[] {
  const keys = ' [Tab/m] Cockpit View │ [↑/↓] Select Asset │ [←/→] Change TF │ [k] Kill-Switch │ [c] Close Pos │ [s] Exit';
  return [
    chalk.cyan('│') + padLine(chalk.gray(keys), w - 2) + chalk.cyan('│'),
    chalk.cyan('└' + rule('─', w - 2) + '┘'),
  ];
}

export function renderMtfScreen(p: MtfScreenProps): string[] {
  const w = Math.max(100, p.totalWidth);
  const btcState = p.marketStates?.['BTCUSDT'] ?? p.marketStates?.['BTC'];
  const btcTick = p.spotPrices?.['BTCUSDT'] ?? p.spotPrices?.['BTC'];
  const curState = p.marketStates?.[p.selectedSymbol] ?? p.marketStates?.[shortName(p.selectedSymbol)];
  const candles = p.mtfCandles?.[p.selectedSymbol]?.[p.selectedTimeframe] ?? [];

  return [
    ...renderMtfHeader(p, w),
    ...renderAnchorCard(w, btcState, btcTick),
    ...renderMatrixTable(p, w),
    ...renderMicroFooter(p.selectedSymbol, p.selectedTimeframe, w, curState),
    ...renderAsciiCandleChart(candles, p.selectedSymbol, p.selectedTimeframe, w, 8),
    ...renderMtfFooter(w),
  ];
}
