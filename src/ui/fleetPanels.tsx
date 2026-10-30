import chalk from 'chalk';
import stringWidth from 'string-width';
import type { FleetState } from '../minicpm/FleetSupervisor.js';
import { shortModelTag } from '../minicpm/FleetModels.js';
import { padLine, rule } from './format.js';

/**
 * The FLEET view of the dev cockpit: same content philosophy as the standalone fleet dashboard
 * (worker table + per-symbol intelligence) rendered as plain lines for the React/termina TUI.
 * Pure function of FleetState — no console I/O, no timers.
 */

export interface FleetScreenProps {
  state: FleetState;
  time: string;
  totalWidth: number;
  totalHeight: number;
}

const shortName = (sym: string) => sym.replace('USDT', '');
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return chalk.gray('—');
  const sign = value >= 0 ? '' : '-';
  return `${value >= 0 ? chalk.green(`${sign}$${Math.abs(value).toFixed(2)}`) : chalk.red(`${sign}$${Math.abs(value).toFixed(2)}`)}`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) current = candidate;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function truncateToWidth(text: string, width: number): string {
  if (stringWidth(stripAnsi(text)) <= width) return text;
  let out = text;
  while (out && stringWidth(stripAnsi(out)) > width - 1) out = out.slice(0, -1);
  return `${out}…`;
}

const stateLabel = (state: string): string =>
  state === 'IN_POSITION' ? chalk.bold.yellow('IN_POSITION')
  : state === 'ANALYZING' ? chalk.bold.cyan('ANALYZING ')
  : chalk.gray('IDLE      ');

export function renderFleetScreen(p: FleetScreenProps): string[] {
  const W = Math.max(60, p.totalWidth);
  const lines: string[] = [];

  const box = (content: string) => chalk.bold.cyan('│') + padLine(content, W - 2) + chalk.bold.cyan('│');
  const topRule = (label: string) => {
    const labelWidth = stripAnsi(label).length;
    const dashes = Math.max(1, W - 2 - labelWidth);
    return chalk.bold.cyan('┌') + chalk.bold.cyan(label) + chalk.bold.cyan(rule('─', dashes)) + chalk.bold.cyan('┐');
  };
  const midRule = () => chalk.bold.cyan('├') + chalk.bold.cyan(rule('─', W - 2)) + chalk.bold.cyan('┤');
  const bottomRule = () => chalk.bold.cyan('└') + chalk.bold.cyan(rule('─', W - 2)) + chalk.bold.cyan('┘');

  if (!p.state.enabled) {
    lines.push(topRule(chalk.bold.cyan(' FLEET — embedded multi-model traders (parked) ')));
    lines.push(box(chalk.yellow('  The embedded fleet is parked. It never blocks the main agent.')));
    lines.push(box(chalk.yellow(`  Reason: ${p.state.disabledReason ?? 'unknown'}`)));
    lines.push(box(''));
    lines.push(box(chalk.gray('  To enable:   export PAPER_EXCHANGE_API_KEY=<paper_exchange operator token>')));
    lines.push(box(chalk.gray('               npm run dev        # then cycle views with Tab/m to FLEET')));
    lines.push(box(chalk.gray('  To opt out:  FLEET_IN_DEV=off npm run dev')));
    lines.push(box(chalk.gray('  Standalone fleet (identical worker path): npm run fleet')));
    lines.push(bottomRule());
    return lines;
  }

  const symbols = Object.keys(p.state.bySymbol);
  const modelSet = [...new Set(Object.values(p.state.assignment))];
  const oneModel = modelSet.length === 1 ? shortModelTag(modelSet[0] ?? '') : null;
  const modeLabel = p.state.entriesEnabled ? chalk.bold.yellow('LIVE (risk-gated)') : chalk.bold.cyan('SHADOW ANALYSIS (R1)');
  const uptimeSec = Math.max(0, Math.floor((Date.now() - p.state.startedAt) / 1000));
  const uptime = uptimeSec >= 3600
    ? `${Math.floor(uptimeSec / 3600)}h${Math.floor((uptimeSec % 3600) / 60)}m`
    : `${Math.floor(uptimeSec / 60)}m${uptimeSec % 60}s`;

  lines.push(topRule(chalk.bold.cyan(' FLEET — embedded multi-model traders ')));
  lines.push(box(`  Mode: ${modeLabel} · Host: ${chalk.gray(p.state.llmHost)} · Uptime: ${chalk.bold(uptime)}`));
  const modelLine = oneModel
    ? `Model: ${chalk.magenta(oneModel)}`
    : `Models: ${chalk.gray(modelSet.map((t) => shortModelTag(t)).join(' '))}`;
  lines.push(box(`  ${modelLine} · Entries: ${p.state.entriesEnabled ? chalk.yellow('ARMED') : chalk.green('OFF')} · ${chalk.gray(p.time)}`));
  lines.push(midRule());

  // ── Worker table ──
  const cAsset = 6, cModel = 15, cState = 13, cPrice = 12, cPnl = 12;
  lines.push(box('  ' + [
    'ASSET'.padEnd(cAsset), 'MODEL'.padEnd(cModel), 'STATE'.padEnd(cState),
    'MARK'.padStart(cPrice), 'uPNL'.padStart(cPnl), 'SL / TP',
  ].join(' ')));

  for (const symbol of symbols) {
    const s = p.state.bySymbol[symbol];
    const mark = s.activePosition?.currentPrice ?? null;
    const slTp = s.stopLoss !== null && s.takeProfit !== null
      ? `${chalk.red(s.stopLoss.toFixed(2))} / ${chalk.green(s.takeProfit.toFixed(2))}${s.breakEvenMoved ? chalk.bold.cyan(' [BE]') : ''}`
      : chalk.gray('—');
    const row = [
      chalk.bold.white(shortName(symbol)).padEnd(cAsset),
      chalk.magenta(shortModelTag(s.modelTag)).padEnd(cModel),
      stateLabel(s.state),
      (mark !== null ? chalk.bold.white(mark.toFixed(2)) : chalk.gray('—')).padStart(cPrice),
      fmtMoney(s.activePosition?.unrealizedPnl ?? null).padStart(cPnl),
      slTp,
    ].join(' ');
    lines.push(box(truncateToWidth(`  ${row}`, W - 2)));
  }
  if (symbols.length === 0) lines.push(box(chalk.gray('  (workers starting…)')));
  lines.push(midRule());

  // ── Intelligence panel ──
  lines.push(box(chalk.bold.white(' LATEST LLM INTELLIGENCE & REASONING:')));
  for (const symbol of symbols) {
    const s = p.state.bySymbol[symbol];
    const prefix = `  ${chalk.bold.magenta(shortName(symbol))} ${chalk.gray(`[${shortModelTag(s.modelTag)}]`)}: `;
    const indent = ' '.repeat(stripAnsi(prefix).length);
    const text = s.lastDecision.replace(/^Recovered:\s*/, '') + (s.breakEvenMoved ? ' [PROTECTED BREAK-EVEN]' : '');
    const wrapped = wrapText(text, Math.max(20, W - 4 - stripAnsi(prefix).length));
    for (let j = 0; j < wrapped.length; j++) {
      const line = j === 0 ? `${prefix}${wrapped[j]}` : `${indent}${wrapped[j]}`;
      lines.push(box(truncateToWidth(line, W - 2)));
    }
  }
  lines.push(midRule());
  lines.push(box(chalk.gray('  $1,000 margin · 10x isolated · min +5% TP · auto break-even trailing · per-model attribution (openedByModel)')));
  lines.push(box(chalk.gray('  Buy/sell/exit fills send [FLEET]-tagged Telegram trade notifications (same bot config; FLEET_TELEGRAM=off disables).')));
  lines.push(bottomRule());
  return lines;
}
