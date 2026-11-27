import { escapeHtml, isTelegramDryRun, sendTelegram, type TelegramDeps } from '../ops/telegram.js';
import type { NotifySlot, NotifyStatus, PlanResult, TradePlanLedger } from '../ops/tradePlans.js';

/**
 * FleetTelegram: per-worker trade notifications for the LLM fleet.
 *
 * The fleet DOES send Telegram notifications for its own trade events — every entry fill
 * (buy/sell), every exit fill (stop-loss / take-profit / break-even) and the break-even lock
 * itself posts a `[FLEET]`-tagged card so the operator sees each worker's actions live.
 *
 * Design contract (the part that must never change):
 *
 *   - these cards go through the LOW-LEVEL `sendTelegram` on the same bot/chat config the
 *     operator already uses (`TELEGRAM_TRADING_BOT_TOKEN`/`TELEGRAM_BOT_TOKEN` +
 *     `TELEGRAM_CHAT_ID`), so there is nothing new to configure;
 *   - the fleet never touches the main agent's alert pipeline — no `sendAlert`, no
 *     `AlertEvent`, no `NotificationEngine`, no opsHooks (enforced by a unit test). The main
 *     agent's alert stream and the fleet's trade stream stay distinguishable: every fleet card
 *     starts with `[FLEET]`, carries the symbol and the model tag that produced the decision;
 *   - notifications are fire-and-forget: unconfigured Telegram or a Telegram outage resolves
 *     `false` and the trading loop continues unaffected;
 *   - `FLEET_TELEGRAM=off` (also `0`/`false`/`no`) is the single opt-out switch.
 */

export type FleetTradeEventKind = 'ENTRY' | 'EXIT' | 'BREAK_EVEN';

export interface FleetTradeEvent {
  readonly kind: FleetTradeEventKind;
  readonly symbol: string;
  /** Order side actually submitted to the paper exchange; omitted for BREAK_EVEN (no order). */
  readonly side?: 'buy' | 'sell';
  /** Ollama tag of the model whose decision produced this event — the fleet's attribution key. */
  readonly model: string;
  /** Fill price (entry/exit) or trigger price (break-even lock). */
  readonly price: number;
  readonly quantity?: number;
  readonly leverage?: number;
  /** 'ENTER_LONG'/'ENTER_SHORT' on entries; 'STOP_LOSS'/'TAKE_PROFIT'/'BREAK_EVEN' on exits. */
  readonly action: string;
  /** Model-stated reason (entry) or a short rationale. */
  readonly note?: string;
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly entryPrice?: number;
  /** Signed realized PnL at the exit fill, USD. */
  readonly pnl?: number;
  readonly at: number;
}

const OFF_VALUES: ReadonlySet<string> = new Set(['off', '0', 'false', 'no']);

/** Default ON — the operator asked for fleet trade notifications; `FLEET_TELEGRAM=off` is the opt-out. */
export const fleetTelegramEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => !OFF_VALUES.has((env.FLEET_TELEGRAM ?? '').trim().toLowerCase());

const fmtPrice = (value: number): string =>
  Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(4);

const fmtPnl = (pnl: number): string => `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;

const NOTE_LIMIT = 240;

/** Renders the [FLEET] card body. Plain numbers stay unescaped; model/note text is LLM output and gets escaped. */
export function formatFleetEventHtml(event: FleetTradeEvent): string {
  const lines: string[] = [];
  if (event.kind === 'ENTRY') {
    lines.push(`<b>[FLEET] ${escapeHtml(event.symbol)} ${event.side === 'sell' ? 'SELL' : 'BUY'} — ${escapeHtml(event.action)}</b>`);
    lines.push(
      `Entry $${fmtPrice(event.price)}${event.quantity !== undefined ? ` · Qty ${event.quantity}` : ''}` +
        `${event.leverage !== undefined ? ` · ${event.leverage}x` : ''}`,
    );
  } else if (event.kind === 'EXIT') {
    const pnlSuffix = event.pnl !== undefined ? ` (${fmtPnl(event.pnl)})` : '';
    lines.push(`<b>[FLEET] ${escapeHtml(event.symbol)} ${event.side === 'sell' ? 'SELL' : 'BUY'} — ${escapeHtml(event.action)}${pnlSuffix}</b>`);
    lines.push(
      `Exit $${fmtPrice(event.price)}${event.quantity !== undefined ? ` · Qty ${event.quantity}` : ''}` +
        `${event.entryPrice !== undefined ? ` · entered $${fmtPrice(event.entryPrice)}` : ''}`,
    );
  } else {
    lines.push(`<b>[FLEET] ${escapeHtml(event.symbol)} — BREAK-EVEN LOCKED</b>`);
    lines.push(`SL moved to entry $${fmtPrice(event.entryPrice ?? event.price)} at $${fmtPrice(event.price)}`);
  }
  if (event.stopLoss !== undefined || event.takeProfit !== undefined) {
    const sl = event.stopLoss !== undefined ? `$${fmtPrice(event.stopLoss)}` : '—';
    const tp = event.takeProfit !== undefined ? `$${fmtPrice(event.takeProfit)}` : '—';
    lines.push(`SL ${sl} · TP ${tp}`);
  }
  lines.push(`Model <code>${escapeHtml(event.model)}</code>`);
  if (event.note) {
    const note = event.note.length > NOTE_LIMIT ? `${event.note.slice(0, NOTE_LIMIT)}…` : event.note;
    lines.push(`Reason: ${escapeHtml(note)}`);
  }
  return lines.join('\n');
}

export interface FleetSendDeps extends TelegramDeps {
  /** Trade-plan ledger the fleet's entries and exits are written to. Absent: cards still go out, nothing is recorded. */
  readonly plans?: TradePlanLedger;
}

/** A fleet worker holds at most one position per symbol, so the symbol plus the entry time names the plan. */
export const fleetPlanId = (symbol: string, at: number): string => `FLEET:${symbol}:${at}`;

const EXIT_RESULT: Readonly<Record<string, PlanResult>> = { STOP_LOSS: 'SL', TAKE_PROFIT: 'TP', BREAK_EVEN: 'BREAK_EVEN' };

/**
 * Writes an ENTRY or EXIT into the plan ledger, synchronously and before any I/O, so the record exists whether or not the
 * card is sent. Returns the slot that the card's delivery status belongs to. BREAK_EVEN moves a stop and leaves the position open.
 */
function recordFleetPlan(plans: TradePlanLedger | undefined, event: FleetTradeEvent): { planId: string; slot: NotifySlot } | undefined {
  if (!plans) return undefined;
  if (event.kind === 'ENTRY') {
    const planId = fleetPlanId(event.symbol, event.at);
    // A position still open for this symbol ended while nothing observed it: the worker could not have opened a new one otherwise
    for (const stale of plans.openFor('FLEET', event.symbol)) {
      plans.close(stale.planId, { at: event.at, result: 'UNOBSERVED', exitPrice: null, pnl: null });
    }
    const announced = plans.announce({
      planId, source: 'FLEET', symbol: event.symbol, side: event.side === 'sell' ? 'SHORT' : 'LONG', strategy: event.model, at: event.at,
      planned: { entry: event.price, stopLoss: event.stopLoss ?? NaN, takeProfit: event.takeProfit ?? NaN },
      meta: { action: event.action, ...(event.quantity === undefined ? {} : { quantity: event.quantity }) },
    });
    if (!announced.applied) return undefined;
    plans.fill(planId, event.at);
    return { planId, slot: 'announce' };
  }
  if (event.kind === 'EXIT') {
    const open = plans.openFor('FLEET', event.symbol)[0];
    if (!open) return undefined;
    const closed = plans.close(open.planId, {
      at: event.at, result: EXIT_RESULT[event.action] ?? 'CLOSE', exitPrice: event.price,
      entryPrice: event.entryPrice ?? null, pnl: event.pnl ?? null,
    });
    return closed.applied ? { planId: open.planId, slot: 'close' } : undefined;
  }
  return undefined;
}

/**
 * Sends one fleet trade card. Buy/sell fills are TRADE-class events, so they use the trading
 * bot (falling back to the shared bot) exactly like the main agent's own fills; the break-even
 * lock is informational and arrives silently. Resolves `false` — never throws — when disabled,
 * unconfigured, timed out or unreachable.
 */
export async function sendFleetEvent(event: FleetTradeEvent, deps: FleetSendDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const recorded = recordFleetPlan(deps.plans, event);
  const report = (status: NotifyStatus): void => {
    if (recorded) deps.plans?.notify(recorded.planId, recorded.slot, status, event.at);
  };
  if (!fleetTelegramEnabled(env)) { report('NOT_ATTEMPTED'); return false; }
  const sent = await sendTelegram(
    formatFleetEventHtml(event),
    { channel: 'trading', silent: event.kind === 'BREAK_EVEN' },
    deps,
  );
  report(sent ? (deps.dryRun ?? isTelegramDryRun(env) ? 'DRY_RUN' : 'SENT') : 'FAILED');
  return sent;
}
