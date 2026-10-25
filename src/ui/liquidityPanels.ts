import chalk from 'chalk';
import { formatPrice, formatQty } from '../binance/symbolRules.js';
import type { LiquidityEvent } from '../microstructure/LiquidityEvents.js';
import type { FieldCell, FieldView, FlowPhase, MicrostructureReading, MicroView, WindowFlow } from '../microstructure/MicrostructureEngine.js';
import type { MarketState, TrendDirection } from '../market/types.js';
import type { MicroFeedHandle } from '../microstructure/MicrostructureFeed.js';
import { padLine, rule } from './format.js';

export interface LiquidityScreenProps {
  feed?: MicroFeedHandle;
  symbols: string[];
  selectedSymbol: string;
  /** Raw ladder drill-down instead of the event timeline. */
  showLadder: boolean;
  /** Field time span (FIELD_SPANS_MS); `w` cycles it. */
  spanMs: number;
  /** Closed-candle market state per symbol, for the 15m / 1h / 4h context line. */
  marketStates?: Record<string, MarketState>;
  time: string;
  totalWidth: number;
  totalHeight: number;
}

const RIGHT_WIDTH = 46;
const PRICE_LABEL = 11;
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const short = (s: string) => s.replace(/USDT$/, '');
const border = chalk.cyan;
const head = (text: string) => chalk.cyan.bold(text);
// Rounds before choosing the sign so a tiny negative never renders as "-0.00"
const signed = (n: number | null, digits = 2, suffix = '') => {
  if (n === null) return '—';
  const r = Number(n.toFixed(digits));
  return `${r < 0 ? '-' : '+'}${Math.abs(r).toFixed(digits)}${suffix}`;
};

const DENSITY = ['░', '▒', '▓', '█'];

/**
 * One field cell. Truecolor terminals: background = displayed liquidity (green bid / red ask gradient), glyph = mid
 * path or an executed-trade pulse. Anything less (256/16 colours, or none) cannot show a gradient, so depth becomes a
 * density glyph ░▒▓█ and the path/pulse glyphs take precedence over it.
 */
export function renderCell(c: FieldCell, colorLevel: number = chalk.level): string {
  if (c.unknown) return chalk.gray('·');
  const pulse = Math.max(c.buy, c.sell);
  const pulseGlyph = pulse >= 0.66 ? '●' : pulse >= 0.33 ? '•' : '·';
  const pulseColor = c.buy >= c.sell ? chalk.greenBright.bold : chalk.redBright.bold;
  const depth = Math.max(c.bid, c.ask);
  if (colorLevel < 3) {
    if (c.path) return chalk.whiteBright.bold('━');
    if (pulse > 0) return pulseColor(pulseGlyph);
    if (depth <= 0) return ' ';
    const glyph = DENSITY[Math.min(DENSITY.length - 1, Math.floor(depth * DENSITY.length))];
    return (c.bid >= c.ask ? chalk.green : chalk.red)(glyph);
  }
  let paint = (text: string) => text;
  if (depth > 0) {
    paint = c.bid >= c.ask
      ? (text: string) => chalk.bgRgb(0, Math.round(40 + 175 * c.bid), Math.round(28 + 90 * c.bid))(text)
      : (text: string) => chalk.bgRgb(Math.round(50 + 180 * c.ask), Math.round(8 * c.ask), Math.round(32 + 50 * c.ask))(text);
  }
  if (c.path) return paint(chalk.whiteBright.bold('━'));
  if (pulse > 0) return paint(pulseColor(pulseGlyph));
  return paint(' ');
}

export const spanLabel = (ms: number) => (ms >= 3_600_000 ? `${ms / 3_600_000}h` : ms >= 60_000 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`);

function fieldLines(symbol: string, field: FieldView, width: number): string[] {
  const lines = field.cells.map((row, r) => {
    const label = formatPrice(symbol, field.rowPrices[r]).padStart(PRICE_LABEL - 2);
    const marker = r === field.midRow ? chalk.whiteBright('▶') : ' ';
    // A wide column repeats its depth and path; the trade pulse is drawn once, so pulse counts stay readable.
    const cells = row.map((cell, i) => renderCell(cell) + (field.cellWidths[i] > 1 ? renderCell({ ...cell, buy: 0, sell: 0 }).repeat(field.cellWidths[i] - 1) : '')).join('');
    return padLine(`${r === field.midRow ? chalk.whiteBright(label) : chalk.gray(label)}${marker} ${cells}`, width);
  });
  const axisWidth = field.cellWidths.reduce((a, b) => a + b, 0);
  const left = `◀ ${spanLabel(field.spanMs)}`;
  const right = `${spanLabel(field.resolutionMs)}/col · now`;
  lines.push(padLine(`${' '.repeat(PRICE_LABEL)}${chalk.gray(left + ' ' + rule('─', axisWidth - left.length - right.length - 2) + ' ' + right)}`, width));
  return lines;
}

const PHASE_NAME: Record<FlowPhase, string> = {
  INITIATIVE_BUYING: 'initiative buying', BUY_ABSORBED: 'buying absorbed', INITIATIVE_SELLING: 'initiative selling', SELL_ABSORBED: 'selling absorbed',
  DRIFT_UP: 'drift up, no dominant flow', DRIFT_DOWN: 'drift down, no dominant flow', BALANCED: 'balanced', THIN: 'too few trades to read',
};
const PHASE_SHORT: Record<FlowPhase, [string, (s: string) => string]> = {
  INITIATIVE_BUYING: ['BUY↑', chalk.green], BUY_ABSORBED: ['BUY=', chalk.yellow], INITIATIVE_SELLING: ['SELL↓', chalk.red], SELL_ABSORBED: ['SELL=', chalk.yellow],
  DRIFT_UP: ['drift↑', chalk.gray], DRIFT_DOWN: ['drift↓', chalk.gray], BALANCED: ['bal', chalk.gray], THIN: ['thin', chalk.gray],
};
const COL = 8;
const LABEL = 11;

/** One column per rolling window: short bursts read against the longer backdrop instead of replacing it. */
function flowTableLines(r: MicrostructureReading, w: number): string[] {
  const ws = r.windows;
  const cell = (text: string, color: (s: string) => string = chalk.white) => color(text.padStart(COL));
  const tone = (n: number | null) => (n === null ? chalk.gray : n > 0 ? chalk.green : n < 0 ? chalk.red : chalk.white);
  const row = (label: string, value: (x: WindowFlow) => [string, (s: string) => string]) =>
    padLine(` ${chalk.gray(label.padEnd(LABEL))}${ws.map((x) => { const [t, c] = value(x); return cell(t, c); }).join('')}`, w);
  return [
    padLine(` ${head('ORDER FLOW')} ${chalk.gray('30s')} ${chalk.white(PHASE_NAME[r.phase])}`, w),
    padLine(` ${' '.repeat(LABEL)}${ws.map((x) => cell(`${spanLabel(x.ms)}${x.complete ? '' : '*'}`, x.complete ? chalk.cyan : chalk.gray)).join('')}`, w),
    row('trade Δ', (x) => [signed(x.delta), tone(x.delta)]),
    row('OFI/depth', (x) => [signed(x.ofi, 1), tone(x.ofi)]),
    row('price bp', (x) => [signed(x.priceBps, 1), tone(x.priceBps)]),
    row('phase', (x) => PHASE_SHORT[x.phase]),
    padLine(chalk.gray(` * window longer than the live stretch`), w),
  ];
}

/** -1 (ask heavy) .. +1 (bid heavy), drawn from the center outward. */
export function gauge(value: number | null, cells = 20): string {
  if (value === null) return chalk.gray('─'.repeat(cells) + '  —');
  const half = cells / 2;
  const n = Math.round(Math.min(1, Math.abs(value)) * half);
  const left = value > 0 ? ' '.repeat(half - n) + chalk.green('█'.repeat(n)) : ' '.repeat(half);
  const right = value < 0 ? chalk.red('█'.repeat(n)) + ' '.repeat(half - n) : ' '.repeat(half);
  return `${chalk.gray('bid')}${left}${chalk.white('│')}${right}${chalk.gray('ask')} ${signed(value)}`;
}

function sparkline(series: number[], cells: number): string {
  const s = series.slice(-cells);
  if (s.length < 2) return chalk.gray('collecting…');
  const lo = Math.min(...s);
  const hi = Math.max(...s);
  const up = s[s.length - 1] >= s[0];
  return (up ? chalk.green : chalk.red)(s.map((v) => SPARKS[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join(''));
}

const usdShort = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);

function flowLines(r: MicrostructureReading, cvd: number[], spanMs: number, w: number): string[] {
  return [
    padLine(` ${head('AGGRESSOR FLOW')} ${chalk.gray('30s')} ${chalk.green(`buy ${usdShort(r.flow.buyNotional30s)}`)} ${chalk.red(`sell ${usdShort(r.flow.sellNotional30s)}`)}`, w),
    padLine(` ${chalk.gray(`CVD ${spanLabel(spanMs).padEnd(3)}`)} ${sparkline(cvd, w - 10)}`, w),
  ];
}

function depthLines(r: MicrostructureReading, w: number): string[] {
  return [
    padLine(` ${head('DISPLAYED DEPTH')} ${chalk.gray('imbalance, cancellable')}`, w),
    padLine(` ${chalk.gray('±10bp')} ${gauge(r.depthImbalance.bps10)}`, w),
    padLine(` ${chalk.gray('±25bp')} ${gauge(r.depthImbalance.bps25)}`, w),
  ];
}

function frictionLines(symbol: string, r: MicrostructureReading, w: number): string[] {
  const f = r.friction;
  const badge = f.status === 'OK' ? chalk.black.bgGreen(' OK ') : f.status === 'ELEVATED' ? chalk.black.bgYellow(' ELEVATED ') : chalk.white.bgRed(' BLOCK ');
  const bp = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}bp`);
  return [
    padLine(` ${head('EXECUTION FRICTION')} ${badge}`, w),
    padLine(chalk.gray(` spread ${bp(f.spreadBps)}  ${usdShort(f.orderNotional)} buy ${bp(f.buySlipBps)} sell ${bp(f.sellSlipBps)}`), w),
    padLine(chalk.gray(` book ${r.book.status.toLowerCase()}${r.book.ageMs === null ? '' : ` ${r.book.ageMs}ms`}${f.reasons.length ? ` · ${f.reasons[0]}` : ''}${r.mid !== null ? ` · mid ${formatPrice(symbol, r.mid)}` : ''}`), w),
  ];
}

const age = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s` : `${Math.floor(ms / 1000)}s`);

function trend4h(state: MarketState): TrendDirection {
  const tf = state.timeframes['4h'];
  if (!tf || tf.lastClose <= 0 || tf.ema50 === null) return 'NEUTRAL';
  return tf.lastClose > tf.ema50 ? 'BULLISH' : tf.lastClose < tf.ema50 ? 'BEARISH' : 'NEUTRAL';
}

const trendText = (t: TrendDirection) => (t === 'BULLISH' ? chalk.green('▲') : t === 'BEARISH' ? chalk.red('▼') : chalk.gray('■'));

/** Closed-candle structure the micro bias is read against. A conflict is shown, never resolved here. */
function contextLine(r: MicrostructureReading, state: MarketState | undefined, w: number): string {
  if (!state) return padLine(chalk.gray(' context 15m/1h/4h: waiting for closed candles'), w);
  const h1 = state.htfStructure.trend;
  const opposes = (r.bias.bias === 'LONG' && h1 === 'BEARISH') || (r.bias.bias === 'SHORT' && h1 === 'BULLISH');
  return padLine(` ${chalk.gray('context')} 15m ${trendText(state.ltfStructure.trend)} 1h ${trendText(h1)} 4h ${trendText(trend4h(state))} ${chalk.gray('closed')}${opposes ? chalk.yellow(' · 1h opposes bias') : ''}`, w);
}

function biasLines(r: MicrostructureReading, state: MarketState | undefined, w: number): string[] {
  const b = r.bias;
  const badge = b.bias === 'LONG' ? chalk.black.bgGreen(' LONG ') : b.bias === 'SHORT' ? chalk.white.bgRed(' SHORT ') : chalk.black.bgWhite(' NEUTRAL ');
  const held = b.since > 0 ? chalk.gray(` held ${age(Math.max(0, r.t - b.since))}`) : '';
  const pending = b.candidate
    ? chalk.yellow(` → ${b.candidate.bias} ${Math.min(Math.floor((r.t - b.candidate.since) / 1000), b.candidate.needMs / 1000)}/${b.candidate.needMs / 1000}s`)
    : '';
  const raw = r.evidence === 'INVALID' ? chalk.gray('invalid') : r.evidence === 'SUPPORTS_LONG' ? chalk.green('long') : r.evidence === 'SUPPORTS_SHORT' ? chalk.red('short') : chalk.gray(r.evidence.toLowerCase());
  return [
    padLine(` ${head('MICRO BIAS')} ${badge}${held}${pending}`, w),
    padLine(chalk.gray(` ${b.reasons.join(' · ') || '—'}`), w),
    padLine(` ${chalk.gray('this second:')} ${raw}${chalk.gray(r.evidenceReasons.length ? ` · ${r.evidenceReasons.join(' · ')}` : '')}`, w),
    contextLine(r, state, w),
    padLine(chalk.gray.italic(' confirmed 10s, released 30s · not a probability, not wired to orders'), w),
  ];
}

const KIND_LABEL: Record<LiquidityEvent['kind'], string> = { CONCENTRATION: 'WALL', ABSORPTION: 'ABSORB', CONSUMED: 'EATEN', PULLED: 'PULLED' };

function eventLines(symbol: string, events: LiquidityEvent[], rows: number, w: number): string[] {
  const out = [padLine(` ${head('LIQUIDITY EVENTS')}`, w)];
  if (events.length === 0) out.push(padLine(chalk.gray(' none yet'), w));
  for (const e of events.slice(0, rows - 1)) {
    const time = new Date(e.t).toISOString().slice(11, 19);
    const color = e.kind === 'ABSORPTION' ? chalk.yellow : e.kind === 'PULLED' ? chalk.magenta : e.kind === 'CONSUMED' ? chalk.white : chalk.cyan;
    const detail = e.kind === 'ABSORPTION' ? `traded ${formatQty(symbol, e.executedQty)} vs ${formatQty(symbol, e.peakQty)}, held`
      : e.kind === 'CONSUMED' ? `${formatQty(symbol, e.executedQty)} executed${e.priceThrough ? ', price through' : ''}`
        : e.kind === 'PULLED' ? `${formatQty(symbol, e.peakQty)} cancelled after ${Math.round(e.lifetimeMs / 1000)}s`
          : `${formatQty(symbol, e.peakQty)} shown`;
    out.push(padLine(` ${chalk.gray(time)} ${color(KIND_LABEL[e.kind].padEnd(6))} ${e.side === 'bid' ? chalk.green('bid') : chalk.red('ask')} ${formatPrice(symbol, e.price)} ${chalk.gray(detail)}`, w));
  }
  return out;
}

function ladderLines(symbol: string, view: MicroView, rows: number, w: number): string[] {
  const out = [padLine(` ${head('LADDER')} ${chalk.gray('diagnostic drill-down (d)')}`, w)];
  const each = Math.max(1, Math.floor((rows - 1) / 2));
  for (const [p, q] of view.ladder.asks.slice(0, each).reverse()) out.push(padLine(`   ${chalk.red(formatPrice(symbol, p).padStart(12))} ${formatQty(symbol, q).padStart(12)}`, w));
  for (const [p, q] of view.ladder.bids.slice(0, each)) out.push(padLine(`   ${chalk.green(formatPrice(symbol, p).padStart(12))} ${formatQty(symbol, q).padStart(12)}`, w));
  if (out.length === 1) out.push(padLine(chalk.gray(' book not live'), w));
  return out;
}

function sidePanel(symbol: string, view: MicroView | null, showLadder: boolean, spanMs: number, state: MarketState | undefined, rows: number, w: number): string[] {
  if (!view) return [padLine(chalk.gray(' no engine for this symbol'), w)];
  const r = view.reading;
  const sep = padLine(chalk.gray(` ${rule('─', w - 2)}`), w);
  const top = [...biasLines(r, state, w), sep, ...flowTableLines(r, w), sep, ...depthLines(r, w), sep, ...flowLines(r, view.cvdSeries, spanMs, w), sep, ...frictionLines(symbol, r, w), sep];
  const remaining = Math.max(2, rows - top.length);
  return [...top, ...(showLadder ? ladderLines(symbol, view, remaining, w) : eventLines(symbol, r.events, remaining, w))];
}

/**
 * The LIQUIDITY view: what the book and the tape are doing for one symbol, instead of a raw ladder.
 * Left, the pressure field (time x price): background shows displayed liquidity on a log scale from the window's
 * median to its 99th percentile, ━ is the mid path, ● pulses are executed aggressor volume. Right, the derived reading. Output is
 * `totalHeight - 1` lines, like the other views.
 */
export function renderLiquidityScreen(p: LiquidityScreenProps): string[] {
  const width = Math.max(120, p.totalWidth);
  const height = Math.max(30, p.totalHeight) - 1;
  const leftW = width - RIGHT_WIDTH - 3;
  const bodyRows = height - 3 - 2 - 2;
  const view = p.feed ? p.feed.view(p.selectedSymbol, bodyRows - 3 - ((bodyRows - 3) % 2 === 0 ? 1 : 0), leftW - PRICE_LABEL - 1, p.spanMs) : null;
  const r = view?.reading;

  const chips = p.symbols.map((s) => (s === p.selectedSymbol ? chalk.black.bgCyan(` ${short(s)} `) : chalk.gray(` ${short(s)} `))).join('');
  const bookBadge = !p.feed ? chalk.gray('MICROSTRUCTURE OFF')
    : p.feed.state === 'down' ? chalk.white.bgRed(` FEED DOWN `) + chalk.gray(` ${p.feed.lastError ?? ''}`)
      : !r ? chalk.yellow('connecting')
        : r.book.status === 'LIVE' ? chalk.black.bgGreen(' BOOK LIVE ') : chalk.black.bgYellow(` BOOK ${r.book.status} `) + chalk.gray(` ${r.book.reason}`);
  const header = [
    border('╭' + rule('─', width - 2) + '╮'),
    border('│') + padLine(` ${chalk.cyan.bold('LIQUIDITY')} ${chalk.white.bold(p.selectedSymbol)} ${chalk.gray('USD-M')} ${chips}  ${bookBadge}`, width - 12) + padLine(chalk.gray(`${p.time} UTC`), 10) + border('│'),
    border('╰' + rule('─', width - 2) + '╯'),
  ];

  let left: string[];
  if (!view?.field) {
    const why = !p.feed ? 'MICROSTRUCTURE=off' : r ? `book ${r.book.status.toLowerCase()}${r.book.reason ? `: ${r.book.reason}` : ''}` : 'waiting for the first sample';
    left = [padLine(` ${head('LIQUIDITY PRESSURE FIELD')}`, leftW), padLine(chalk.yellow(`  field withheld — ${why}`), leftW)];
  } else {
    left = [
      padLine(` ${head('LIQUIDITY PRESSURE FIELD')} ${chalk.cyan(spanLabel(p.spanMs))} ${chalk.gray(`bucket ${formatPrice(p.selectedSymbol, view.field.bucketSize)} · log depth, median→p99${view.field.resolutionMs > 1_000 ? ' · time-averaged (persistence)' : ''}`)}`, leftW),
      ...fieldLines(p.selectedSymbol, view.field, leftW),
      padLine(` ${chalk.bgRgb(0, 150, 90)(' ')} ${chalk.gray('bid depth')}  ${chalk.bgRgb(190, 0, 60)(' ')} ${chalk.gray('ask depth')}  ${chalk.whiteBright('━')} ${chalk.gray('mid')}  ${chalk.greenBright('●')} ${chalk.gray('buy')}  ${chalk.redBright('●')} ${chalk.gray('sell aggressor')}  ${chalk.gray('· unknown')}`, leftW),
    ];
  }
  const right = sidePanel(p.selectedSymbol, view, p.showLadder, p.spanMs, p.marketStates?.[p.selectedSymbol], bodyRows, RIGHT_WIDTH);
  const body = [border('┌' + rule('─', leftW) + '┬' + rule('─', RIGHT_WIDTH) + '┐')];
  for (let i = 0; i < bodyRows; i += 1) {
    body.push(border('│') + padLine(left[i] ?? '', leftW) + border('│') + padLine(right[i] ?? '', RIGHT_WIDTH) + border('│'));
  }
  body.push(border('└' + rule('─', leftW) + '┴' + rule('─', RIGHT_WIDTH) + '┘'));

  const footer = [
    padLine(chalk.gray(` Tab view │ ↑↓ symbol │ w span (${spanLabel(p.spanMs)}) │ d ladder drill-down │ k kill-switch │ ? help`), width),
    padLine(chalk.gray(' Field and evidence are derived from the local order book and trade tape; they describe, they do not predict.'), width),
  ];
  return [...header, ...body, ...footer];
}
