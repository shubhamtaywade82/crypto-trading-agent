import chalk from 'chalk';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
import { formatPrice } from '../binance/symbolRules.js';
import type { AgentState, MarketPriceInfo } from '../types.js';

// Prices and quantities use each symbol's own precision; every other figure is 2dp
export const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type CurrencyMode = 'USD' | 'INR' | 'BOTH';

const inrShort = (n: number) => {
  const abs = Math.abs(Math.round(n));
  if (abs >= 100_000) return `₹${(abs / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `₹${(abs / 1_000).toFixed(1)}k`;
  return `₹${abs.toLocaleString('en-IN')}`;
};

// Without a venue-reported USDT/INR rate there is no honest rupee figure, so every mode shows dollars
export function fmtCurrency(amount: number, mode: CurrencyMode = 'USD', fxRate?: number): string {
  if (fxRate === undefined) return `$${usd(amount)}`;
  if (mode === 'INR') return `₹${Math.round(amount * fxRate).toLocaleString('en-IN')}`;
  if (mode === 'BOTH') return `$${usd(amount)} (${inrShort(amount * fxRate)})`;
  return `$${usd(amount)}`;
}

export function fmtSignedCurrency(amount: number, mode: CurrencyMode = 'USD', fxRate?: number): string {
  const sign = isNegative(amount) ? '-' : '+';
  const abs = Math.abs(amount);
  if (fxRate === undefined) return `${sign}$${usd(abs)}`;
  if (mode === 'INR') return `${sign}₹${Math.round(abs * fxRate).toLocaleString('en-IN')}`;
  if (mode === 'BOTH') return `${sign}$${usd(abs)} (${inrShort(abs * fxRate)})`;
  return `${sign}$${usd(abs)}`;
}

// Rounds before testing the sign so a tiny loss never renders as "-0.00"
const isNegative = (n: number, digits = 2) => Number(n.toFixed(digits)) < 0;
export const dp = (n: number, digits = 2) => (isNegative(n, digits) ? n : Math.abs(n)).toFixed(digits);
export const signedDp = (n: number, digits = 2) => `${isNegative(n, digits) ? '-' : '+'}${Math.abs(n).toFixed(digits)}`;
export const signedUsd = (n: number) => `${isNegative(n) ? '-' : '+'}$${usd(Math.abs(n))}`;
export const pnlColor = (n: number) => (isNegative(n) ? chalk.red : chalk.green);
export const priceColor = (info?: MarketPriceInfo) => {
  if (!info) return chalk.gray;
  if (!info.tickDirection) return chalk.white;
  if (info.isFlashing) return info.tickDirection === 'UP' ? chalk.green.bold : chalk.red.bold;
  return info.tickDirection === 'UP' ? chalk.green : chalk.red;
};
export const coloredPnl = (n: number | null, mode: CurrencyMode = 'USD', fx?: number) =>
  (n === null ? chalk.gray('—') : pnlColor(n)(fmtSignedCurrency(n, mode, fx)));
// Repeat counts come from terminal size, so they must never go negative
export const rule = (char: string, count: number) => char.repeat(Math.max(0, count));
export const orDash = (n: number | null | undefined, format: (value: number) => string) => (n === null || n === undefined ? '—' : format(n));

export function padLine(str: string, width: number): string {
  const sw = stringWidth(str);
  if (sw === width) return str;
  if (sw < width) return str + ' '.repeat(width - sw);
  return cliTruncate(str, width);
}

export const runningCount = (agents: AgentState[]) => agents.filter((a) => a.status === 'RUNNING').length;

export function fmtVol(v?: number): string {
  if (v === undefined) return '—';
  if (v === 0) return '$0';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  return '$' + (v / 1e3).toFixed(2) + 'K';
}

export function fmtRange(symbol: string, low?: number, high?: number): string {
  if (!low || !high) return '—';
  return `$${formatPrice(symbol, low)} - $${formatPrice(symbol, high)}`;
}

export function boxLines(title: string, content: string[], width: number): string[] {
  const innerW = width - 2;
  return [
    chalk.cyan('┌' + rule('─', innerW) + '┐'),
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold(title), innerW) + chalk.cyan('│'),
    chalk.cyan('├' + rule('─', innerW) + '┤'),
    ...content.map((l) => chalk.cyan('│') + padLine(l, innerW) + chalk.cyan('│')),
    chalk.cyan('└' + rule('─', innerW) + '┘'),
  ];
}

/** Greedily packs tokens into lines no wider than `width`; a lone oversize token gets its own line. */
export function wrapTokens(tokens: string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current === '' ? token : `${current} ${token}`;
    if (current !== '' && stringWidth(candidate) > width) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

// Resolves a short alphabetic timezone abbreviation or falls back to offset
function localTzAbbr(date: Date): string {
  try {
    const shortName = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value;

    if (shortName && /^[A-Z]{2,5}$/.test(shortName)) return shortName;

    const longName = new Intl.DateTimeFormat(undefined, { timeZoneName: 'long' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value;

    if (longName) {
      const letters = longName.replace(/[^A-Za-z\s]/g, '').split(/\s+/).map((w) => w[0]).join('').toUpperCase();
      if (letters.length >= 2 && letters.length <= 5) return letters;
    }

    if (shortName) return shortName;
  } catch {}

  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${h}:${m}`;
}

export function formatLocalTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const tz = localTzAbbr(date);
  return tz ? `${time} ${tz}` : time;
}

