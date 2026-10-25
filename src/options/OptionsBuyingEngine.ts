import { randomUUID } from 'node:crypto';
import type { MarketState } from '../market/types.js';
import type { VetoVerdict } from '../ollama/advisor.js';
import { parseOptionSymbol } from './contract.js';
import type { OptionsConfig } from './config.js';
import { selectContract, type Selection } from './ContractSelector.js';
import { directionFor } from './DirectionEngine.js';
import { evaluateExit, type OptionExitReason } from './ExitPolicy.js';
import type { OptionChainService } from './OptionChainService.js';
import { transition, type OptionTradeEvent } from './OptionPositionMachine.js';
import { OptionRiskBook, planEntry, type EntryPlan, type OpenExposure } from './OptionRiskPlanner.js';
import { emptySlot, type OpenOptionPosition, type OptionsJournal, type OptionsState, type OptionsStateStore, type UnderlyingSlot } from './stateStore.js';
import type { OptionQuote, OptionRight, OptionVetoSnapshot } from './types.js';
import { StaleContextError, type UnderlyingContextSource } from './UnderlyingContext.js';
import { isPersistentVenue, type OptionOrderResult, type OptionsVenue, type VenueOptionPosition } from './venues.js';

export interface OptionVetoer {
  vetoOption(snapshot: OptionVetoSnapshot): Promise<VetoVerdict>;
}

/** The operator kill switch (src/ops/killSwitch.ts): a halt blocks new entries; open positions keep their exits. */
export interface HaltSwitch {
  isHalted(): boolean;
  state(): { reason: string };
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface OptionsEngineDeps {
  config: OptionsConfig;
  chain: OptionChainService;
  context: UnderlyingContextSource;
  venue: OptionsVenue;
  vetoer: OptionVetoer | null;
  killSwitch: HaltSwitch;
  store: OptionsStateStore;
  journal: OptionsJournal;
  log: (level: LogLevel, message: string) => void;
  now?: () => number;
  newId?: () => string;
}

export interface UnderlyingStatus {
  underlying: string;
  state: UnderlyingSlot['state'];
  note: string;
  position: null | { symbol: string; qty: number; entry: number; stop: number; target: number; exitReason?: OptionExitReason };
}

const EPS = 1e-12;

/**
 * Long-only options engine: one finite state machine per underlying (IDLE -> SIGNAL_DETECTED -> ENTRY_PENDING ->
 * POSITION_OPEN -> EXIT_PENDING -> POSITION_CLOSED -> IDLE). Deterministic code decides direction, contract, size and
 * every exit; the LLM can only veto an entry. Invariants:
 *  - an entry order id is persisted before the order is sent, and an unknown outcome is reconciled by that id, never resent
 *    under a new one;
 *  - every open position carries a premium stop, a target, a max-hold and a pre-expiry exit from the moment it opens;
 *  - an exit that fails is retried every cycle, with the same id while its outcome is unknown;
 *  - nothing trades on a stale quote, index or candle feed; time-based exits still fire without a price.
 */
export class OptionsBuyingEngine {
  private state: OptionsState = { version: 1, slots: {}, riskBook: null };
  private riskBook!: OptionRiskBook;
  private readonly notes = new Map<string, string>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private started = false;

  constructor(private readonly deps: OptionsEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID().slice(0, 12));
  }

  private get cfg(): OptionsConfig {
    return this.deps.config;
  }

  /** Loads persisted state, restores the local venue's book, and reconciles every slot against the venue. */
  async start(): Promise<void> {
    const loaded = this.deps.store.load();
    this.state = loaded;
    if (isPersistentVenue(this.deps.venue) && loaded.localVenue) this.deps.venue.importState(loaded.localVenue);
    const now = this.now();
    const equity = await this.deps.venue.equity();
    this.riskBook = new OptionRiskBook(this.cfg.risk, loaded.riskBook, equity, now);
    for (const u of this.cfg.underlyings) this.state.slots[u] ??= emptySlot(now);
    await this.reconcile(now);
    this.persist();
    this.started = true;
    this.deps.log('info', `options engine started on ${this.deps.venue.name} (${this.deps.venue.canExecute ? 'executing' : 'MONITOR ONLY'}), equity ${equity.toFixed(2)} USDT`);
  }

  /** One pass over every underlying. A failure in one underlying never stops the others. */
  async cycle(): Promise<void> {
    if (!this.started) throw new Error('OptionsBuyingEngine.cycle() before start()');
    let equity: number | null = null;
    try {
      equity = await this.deps.venue.equity();
      this.riskBook.rollIfNewDay(equity, this.now());
    } catch (err) {
      this.deps.log('warn', `equity unavailable, entries paused this cycle: ${(err as Error).message}`);
    }
    let venuePositions: VenueOptionPosition[] | null = null;
    try {
      venuePositions = await this.deps.venue.positions();
    } catch (err) {
      this.deps.log('warn', `venue positions unavailable: ${(err as Error).message}`);
    }

    const marks: Record<string, number> = {};
    for (const underlying of this.cfg.underlyings) {
      try {
        await this.step(underlying, equity, venuePositions, marks);
      } catch (err) {
        this.deps.log('error', `${underlying}: ${(err as Error).message}`);
        this.journal(underlying, 'STEP_ERROR', { error: (err as Error).message });
      } finally {
        this.persist();
      }
    }
    if (Object.keys(marks).length > 0) {
      await this.deps.venue.publishMarks(marks).catch((err: Error) => this.deps.log('warn', `mark publish failed: ${err.message}`));
    }
    this.persist();
  }

  status(): UnderlyingStatus[] {
    return this.cfg.underlyings.map((underlying) => {
      const slot = this.slot(underlying);
      const p = slot.position;
      return {
        underlying,
        state: slot.state,
        note: this.notes.get(underlying) ?? '',
        position: p ? { symbol: p.contract.symbol, qty: p.qty, entry: p.entryPrice, stop: p.leg.stopPremium, target: p.leg.targetPremium, exitReason: p.exitReason } : null,
      };
    });
  }

  riskHalt(): string | null {
    return this.riskBook.haltReason();
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async step(underlying: string, equity: number | null, venuePositions: VenueOptionPosition[] | null, marks: Record<string, number>): Promise<void> {
    const slot = this.slot(underlying);
    const now = this.now();
    switch (slot.state) {
      case 'POSITION_CLOSED':
        if (now >= slot.cooldownUntil) this.fire(underlying, 'RESET');
        return;
      case 'SIGNAL_DETECTED':
        // Only ever transient inside one step; on disk it means a crash before any order was sent.
        this.fire(underlying, 'REJECT');
        this.note(underlying, 'recovered from an interrupted signal');
        return;
      case 'ENTRY_PENDING':
        await this.resolvePendingEntry(underlying, venuePositions);
        return;
      case 'POSITION_OPEN':
      case 'EXIT_PENDING':
        if (venuePositions && await this.detectExternalClose(underlying, venuePositions)) return;
        await this.manage(underlying, marks);
        return;
      case 'IDLE':
        if (now < slot.cooldownUntil) {
          this.note(underlying, `cooldown ${Math.ceil((slot.cooldownUntil - now) / 60_000)} min`);
          return;
        }
        await this.tryEntry(underlying, equity);
        return;
    }
  }

  // ---- entry -----------------------------------------------------------------------------------------------------

  private async tryEntry(underlying: string, equity: number | null): Promise<void> {
    if (equity === null) return this.note(underlying, 'equity unavailable');
    if (this.deps.killSwitch.isHalted()) return this.note(underlying, `kill switch: ${this.deps.killSwitch.state().reason}`);
    const halt = this.riskBook.haltReason();
    if (halt) return this.note(underlying, `risk halt: ${halt}`);
    const exposure = this.exposure();
    if (exposure.openPositions >= this.cfg.risk.maxOpenPositions) return this.note(underlying, `${exposure.openPositions} positions open (max ${this.cfg.risk.maxOpenPositions})`);

    let ctx;
    try {
      ctx = await this.deps.context.context(underlying);
    } catch (err) {
      if (err instanceof StaleContextError) return this.note(underlying, `market data: ${err.message}`);
      throw err;
    }
    const view = directionFor(ctx.marketState, ctx.candles1h, this.cfg.direction);
    if (!view.right) return this.note(underlying, `no entry: ${view.reasons.join('; ')}`);
    if (view.realizedVol === null || view.atr1h === null) return this.note(underlying, 'no entry: realized vol / ATR history too short');

    this.fire(underlying, 'SIGNAL');
    this.journal(underlying, 'SIGNAL', { right: view.right, reasons: view.reasons, realizedVol: view.realizedVol, atr1h: view.atr1h });
    try {
      await this.enterFromSignal(underlying, equity, exposure, view.right, view.realizedVol, view.atr1h, ctx.marketState);
    } catch (err) {
      // Before SUBMIT nothing was sent, so any failure is a plain rejection; after it the order id is on disk.
      if (this.slot(underlying).state === 'SIGNAL_DETECTED') return this.reject(underlying, [`error: ${(err as Error).message}`]);
      throw err;
    }
  }

  private async enterFromSignal(underlying: string, equity: number, exposure: OpenExposure, right: OptionRight, realizedVol: number, atr1h: number, marketState: MarketState): Promise<void> {
    const [contracts, index, markMap] = await Promise.all([
      this.deps.chain.contractsFor(underlying),
      this.deps.chain.index(underlying),
      this.deps.chain.marks(),
    ]);
    if (this.now() - index.time > this.cfg.selection.indexStaleMs) return this.reject(underlying, [`index print is ${this.now() - index.time}ms old`]);

    const selected = await selectContract({
      contracts,
      marks: markMap,
      index,
      right,
      realizedVol,
      atr1h,
      now: this.now,
      selection: this.cfg.selection,
      economics: { ...this.cfg.economics, stopPct: this.cfg.exits.stopPct, targetPct: this.cfg.exits.targetPct },
      fees: this.cfg.fees,
      fetchQuote: (symbol, mark) => this.deps.chain.quote(symbol, mark),
    });
    if (!selected.ok) return this.reject(underlying, selected.reasons);
    const { selection } = selected;
    const { contract } = selection.screened;

    const planned = planEntry({
      equity, exposure, contract, quote: selection.quote, indexPrice: index.price,
      stopPct: this.cfg.exits.stopPct, targetPct: this.cfg.exits.targetPct, limits: this.cfg.risk, fees: this.cfg.fees,
    });
    if (!planned.ok) return this.reject(underlying, [`${contract.symbol}: ${planned.reason}`]);
    const plan = planned.plan;

    const snapshot = this.vetoSnapshot(underlying, selection, plan, index.price, realizedVol, marketState);
    if (this.cfg.llmVeto && this.deps.vetoer) {
      const verdict = await this.deps.vetoer.vetoOption(snapshot);
      this.journal(underlying, 'LLM_VERDICT', { contract: contract.symbol, ...verdict });
      if (verdict.verdict === 'VETO') return this.reject(underlying, [`LLM veto: ${verdict.reason}`]);
    }

    if (!this.deps.venue.canExecute) {
      this.journal(underlying, 'WOULD_BUY', { venue: this.deps.venue.name, snapshot });
      this.deps.log('info', `[${this.deps.venue.name}] WOULD BUY ${plan.qty} ${contract.symbol} @ ~${plan.expectedFill.toFixed(4)} (SL ${plan.stopPremium.toFixed(4)}, TP ${plan.targetPremium.toFixed(4)}, max loss ${plan.plannedLoss.toFixed(2)} USDT)`);
      this.fire(underlying, 'REJECT');
      this.slot(underlying).cooldownUntil = this.now() + this.cfg.cooldownMs;
      return this.note(underlying, `monitor: would buy ${contract.symbol}`);
    }

    // The quote may have aged during the veto; re-read the book and refuse if the ask moved past the plan's limit.
    const fresh = await this.deps.chain.quote(contract.symbol, selection.screened.mark);
    const ask = fresh.asks[0]?.[0];
    if (!(ask! > 0) || ask! > plan.limitPrice) return this.reject(underlying, [`${contract.symbol}: ask ${ask ?? 'none'} moved past limit ${plan.limitPrice.toFixed(4)}`]);

    const slot = this.slot(underlying);
    const clientOrderId = `opt-${contract.symbol}-${this.newId()}`;
    slot.pendingEntry = {
      clientOrderId, contract, qty: plan.qty, limitPrice: plan.limitPrice,
      stopPct: this.cfg.exits.stopPct, targetPct: this.cfg.exits.targetPct, submittedAt: this.now(),
    };
    this.fire(underlying, 'SUBMIT');
    this.persist();
    this.journal(underlying, 'ENTRY_SUBMITTED', { clientOrderId, contract: contract.symbol, qty: plan.qty, limitPrice: plan.limitPrice, plan, economics: selection.economics });

    await this.deps.venue.publishMarks({ [underlying]: index.price, [contract.symbol]: fresh.mark })
      .catch((err: Error) => this.deps.log('warn', `mark publish before entry failed: ${err.message}`));
    let result: OptionOrderResult;
    try {
      result = await this.deps.venue.buyToOpen({ contract, qty: plan.qty, limitPrice: plan.limitPrice, book: fresh.asks, indexPrice: index.price, clientOrderId });
    } catch (err) {
      this.deps.log('warn', `${underlying}: entry ${clientOrderId} outcome unknown (${(err as Error).message}); reconciling next cycle`);
      this.journal(underlying, 'ENTRY_UNKNOWN', { clientOrderId, error: (err as Error).message });
      return this.note(underlying, `entry ${clientOrderId} outcome unknown`);
    }
    await this.applyEntryResult(underlying, result, null);
  }

  private async resolvePendingEntry(underlying: string, venuePositions: VenueOptionPosition[] | null): Promise<void> {
    const slot = this.slot(underlying);
    const pending = slot.pendingEntry;
    if (!pending) {
      this.fire(underlying, 'NO_FILL');
      return;
    }
    let found: OptionOrderResult | null;
    try {
      found = await this.deps.venue.findOrder(pending.clientOrderId);
    } catch (err) {
      return this.note(underlying, `entry ${pending.clientOrderId} still unresolved: ${(err as Error).message}`);
    }
    if (found) {
      await this.applyEntryResult(underlying, found, venuePositions);
      return;
    }
    if (venuePositions === null) return this.note(underlying, `entry ${pending.clientOrderId} unresolved: venue positions unavailable`);
    // The venue never recorded the order. A position in the same contract that nothing tracks means it did fill.
    const held = venuePositions.find((p) => p.symbol === pending.contract.symbol);
    if (held && !this.trackedSymbols().has(held.symbol)) {
      await this.applyEntryResult(underlying, { clientOrderId: pending.clientOrderId, status: 'FILLED', filledQty: held.qty, avgPrice: held.avgPrice, fee: 0 }, venuePositions);
      return;
    }
    this.journal(underlying, 'ENTRY_NOT_FOUND', { clientOrderId: pending.clientOrderId });
    this.fire(underlying, 'NO_FILL');
    slot.pendingEntry = undefined;
    slot.cooldownUntil = this.now() + this.cfg.cooldownMs;
  }

  private async applyEntryResult(underlying: string, result: OptionOrderResult, venuePositions: VenueOptionPosition[] | null): Promise<void> {
    const slot = this.slot(underlying);
    const pending = slot.pendingEntry!;
    if (result.filledQty <= EPS) {
      this.journal(underlying, 'ENTRY_NOT_FILLED', { clientOrderId: result.clientOrderId, status: result.status, reason: result.reason });
      this.deps.log('warn', `${underlying}: entry ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      this.fire(underlying, 'NO_FILL');
      slot.pendingEntry = undefined;
      slot.cooldownUntil = this.now() + this.cfg.cooldownMs;
      return this.note(underlying, `entry ${result.status.toLowerCase()}`);
    }
    let entryPrice = result.avgPrice;
    if (!(entryPrice > 0)) {
      // A recovered order may carry no fill price; the venue's position average is the cost actually booked.
      const positions = venuePositions ?? await this.deps.venue.positions();
      entryPrice = positions.find((p) => p.symbol === pending.contract.symbol)?.avgPrice ?? 0;
      if (!(entryPrice > 0)) throw new Error(`${pending.contract.symbol}: filled ${result.filledQty} but no fill price is recoverable`);
    }
    const now = this.now();
    slot.position = {
      contract: pending.contract,
      qty: result.filledQty,
      entryPrice,
      entryFee: result.fee,
      entryClientOrderId: pending.clientOrderId,
      leg: {
        right: pending.contract.right,
        entryPrice,
        stopPremium: entryPrice * (1 - pending.stopPct / 100),
        targetPremium: entryPrice * (1 + pending.targetPct / 100),
        peakBid: entryPrice,
        trailActive: false,
        openedAt: now,
        expiryMs: pending.contract.expiryMs,
      },
      exitAttempts: 0,
      closedQty: 0,
      exitProceeds: 0,
      exitFees: 0,
    };
    slot.pendingEntry = undefined;
    this.fire(underlying, 'FILL');
    const partial = result.filledQty + EPS < pending.qty;
    this.journal(underlying, 'ENTRY_FILLED', { clientOrderId: pending.clientOrderId, contract: pending.contract.symbol, qty: result.filledQty, requested: pending.qty, partial, price: entryPrice, fee: result.fee, stop: slot.position.leg.stopPremium, target: slot.position.leg.targetPremium });
    this.deps.log('info', `${underlying}: BOUGHT ${result.filledQty}${partial ? `/${pending.qty} (partial)` : ''} ${pending.contract.symbol} @ ${entryPrice.toFixed(4)} | SL ${slot.position.leg.stopPremium.toFixed(4)} | TP ${slot.position.leg.targetPremium.toFixed(4)}`);
    this.note(underlying, `long ${pending.contract.symbol}`);
  }

  // ---- position management -------------------------------------------------------------------------------------

  private async manage(underlying: string, marks: Record<string, number>): Promise<void> {
    const slot = this.slot(underlying);
    const pos = slot.position;
    if (!pos) throw new Error(`${underlying}: ${slot.state} without a position`);

    let quote: OptionQuote | null = null;
    try {
      quote = await this.deps.chain.quote(pos.contract.symbol);
      marks[pos.contract.symbol] = quote.mark;
    } catch (err) {
      this.deps.log('warn', `${underlying}: quote for ${pos.contract.symbol} failed: ${(err as Error).message}`);
    }

    if (slot.state === 'POSITION_OPEN') {
      const direction = await this.currentDirection(underlying);
      const decision = evaluateExit({ leg: pos.leg, quote, now: this.now(), staleMs: this.cfg.selection.quoteStaleMs, limits: this.cfg.exits, direction });
      pos.leg = decision.leg;
      if (decision.action === 'STALE') {
        this.journal(underlying, 'STALE_QUOTE', { contract: pos.contract.symbol, ageMs: decision.ageMs });
        return this.note(underlying, `holding ${pos.contract.symbol}: quote stale, no price exit possible`);
      }
      if (decision.action === 'HOLD') return this.note(underlying, `holding ${pos.contract.symbol}${decision.note ? ` (${decision.note})` : ''}`);
      pos.exitReason = decision.reason;
      this.fire(underlying, 'EXIT_TRIGGER');
      this.journal(underlying, 'EXIT_TRIGGERED', { contract: pos.contract.symbol, reason: decision.reason, bid: decision.bid, stop: pos.leg.stopPremium, target: pos.leg.targetPremium });
    }
    await this.executeExit(underlying, quote);
  }

  private async executeExit(underlying: string, quote: OptionQuote | null): Promise<void> {
    const slot = this.slot(underlying);
    const pos = slot.position!;
    const symbol = pos.contract.symbol;
    const now = this.now();
    const bid = quote?.bids[0]?.[0];
    if (!quote || now - quote.receivedAt > this.cfg.selection.quoteStaleMs || !(bid! > 0)) {
      return this.exitFailed(underlying, pos, !quote ? 'no quote' : !(bid! > 0) ? 'no bid' : 'stale quote');
    }
    let indexPrice = 0;
    try {
      indexPrice = (await this.deps.chain.index(underlying)).price;
    } catch {
      // The fee estimate falls back to its premium cap; the exit itself must not wait for an index print.
    }
    const clientOrderId = pos.unresolvedExitId ?? `${pos.entryClientOrderId}-x${pos.exitAttempts + 1}`;
    const limitPrice = bid! * (1 - this.cfg.risk.maxSlippagePct / 100);
    let result: OptionOrderResult;
    try {
      result = await this.deps.venue.sellToClose({ contract: pos.contract, qty: pos.qty, limitPrice, book: quote.bids, indexPrice, clientOrderId });
    } catch (err) {
      pos.unresolvedExitId = clientOrderId;
      return this.exitFailed(underlying, pos, `outcome unknown: ${(err as Error).message}`);
    }
    pos.unresolvedExitId = undefined;
    pos.exitAttempts += 1;
    this.applyExitResult(underlying, result, limitPrice);
  }

  private applyExitResult(underlying: string, result: OptionOrderResult, fallbackPrice: number): void {
    const slot = this.slot(underlying);
    const pos = slot.position!;
    if (result.filledQty <= EPS) {
      this.journal(underlying, 'EXIT_NOT_FILLED', { clientOrderId: result.clientOrderId, status: result.status, reason: result.reason });
      this.fire(underlying, 'EXIT_RETRY');
      this.alertIfStuck(underlying, pos, result.reason ?? result.status);
      return;
    }
    const price = result.avgPrice > 0 ? result.avgPrice : fallbackPrice;
    const filled = Math.min(result.filledQty, pos.qty);
    pos.closedQty += filled;
    pos.exitProceeds += filled * price;
    pos.exitFees += result.fee;
    pos.qty = Number((pos.qty - filled).toFixed(12));
    this.journal(underlying, 'EXIT_FILLED', { clientOrderId: result.clientOrderId, qty: filled, price, fee: result.fee, remaining: pos.qty, reason: pos.exitReason });
    if (pos.qty > EPS) {
      this.fire(underlying, 'PARTIAL_EXIT');
      this.deps.log('warn', `${underlying}: partial exit ${filled} @ ${price.toFixed(4)}, ${pos.qty} ${pos.contract.symbol} left`);
      return this.note(underlying, `exiting ${pos.contract.symbol}: ${pos.qty} left`);
    }
    this.closeOut(underlying, 'EXIT_FILL', null);
  }

  /** Attempts keep counting while an outcome is unknown, so a venue that stays down escalates the alert. */
  private exitFailed(underlying: string, pos: OpenOptionPosition, reason: string): void {
    pos.exitAttempts += 1;
    this.journal(underlying, 'EXIT_RETRY', { contract: pos.contract.symbol, reason, attempts: pos.exitAttempts });
    this.fire(underlying, 'EXIT_RETRY');
    this.alertIfStuck(underlying, pos, reason);
  }

  private alertIfStuck(underlying: string, pos: OpenOptionPosition, reason: string): void {
    const level = pos.exitAttempts >= this.cfg.exits.maxExitAttemptsBeforeAlert ? 'error' : 'warn';
    this.deps.log(level, `${underlying}: exit of ${pos.contract.symbol} (${pos.exitReason}) not done after ${pos.exitAttempts} attempt(s): ${reason}`);
    this.note(underlying, `exit pending (${pos.exitReason}): ${reason}`);
  }

  /** `pnlOverride` is used when the venue closed the position without this engine seeing the fills. */
  private closeOut(underlying: string, event: 'EXIT_FILL' | 'EXTERNAL_CLOSE', pnlOverride: number | null): void {
    const slot = this.slot(underlying);
    const pos = slot.position!;
    const cost = pos.closedQty * pos.entryPrice + pos.entryFee;
    const pnl = pnlOverride ?? (pos.exitProceeds - pos.exitFees - cost);
    const now = this.now();
    this.riskBook.record({ pnl, closedAt: now });
    this.journal(underlying, 'POSITION_CLOSED', { contract: pos.contract.symbol, reason: event === 'EXIT_FILL' ? pos.exitReason : 'EXTERNAL_CLOSE', pnl, entry: pos.entryPrice, qty: pos.closedQty, pnlAssumed: pnlOverride !== null, riskBook: this.riskBook.snapshot() });
    this.deps.log(pnl >= 0 ? 'info' : 'warn', `${underlying}: CLOSED ${pos.contract.symbol} (${event === 'EXIT_FILL' ? pos.exitReason : 'external'}) PnL ${pnl.toFixed(2)} USDT`);
    this.fire(underlying, event);
    slot.position = undefined;
    slot.cooldownUntil = now + this.cfg.cooldownMs;
    this.note(underlying, `closed, PnL ${pnl.toFixed(2)}`);
  }

  /**
   * A tracked position the venue no longer holds. A lost exit reply is resolved by its id first; anything else
   * (venue expiry settlement, a manual close) is booked at the worst case, the whole premium, so the daily-loss
   * governor can only overstate the damage.
   */
  private async detectExternalClose(underlying: string, venuePositions: VenueOptionPosition[]): Promise<boolean> {
    const slot = this.slot(underlying);
    const pos = slot.position;
    if (!pos || venuePositions.some((p) => p.symbol === pos.contract.symbol && p.qty > EPS)) return false;
    if (pos.unresolvedExitId) {
      const found = await this.deps.venue.findOrder(pos.unresolvedExitId);
      if (found && found.filledQty > EPS) {
        pos.unresolvedExitId = undefined;
        pos.exitAttempts += 1;
        // The order is gone from the venue's book of positions, so it closed everything that was left.
        this.applyExitResult(underlying, { ...found, filledQty: pos.qty }, found.avgPrice || pos.leg.stopPremium);
        return true;
      }
    }
    const worstCase = -(pos.qty * pos.entryPrice) + (pos.exitProceeds - pos.exitFees) - (pos.closedQty * pos.entryPrice) - pos.entryFee;
    this.deps.log('error', `${underlying}: ${pos.contract.symbol} is no longer on ${this.deps.venue.name}; booking worst-case PnL ${worstCase.toFixed(2)} — check the venue ledger`);
    pos.closedQty += pos.qty;
    pos.qty = 0;
    this.closeOut(underlying, 'EXTERNAL_CLOSE', worstCase);
    return true;
  }

  // ---- reconciliation --------------------------------------------------------------------------------------------

  private async reconcile(now: number): Promise<void> {
    const venuePositions = await this.deps.venue.positions();
    for (const underlying of this.cfg.underlyings) {
      const slot = this.slot(underlying);
      const pos = slot.position;
      if (!pos || (slot.state !== 'POSITION_OPEN' && slot.state !== 'EXIT_PENDING')) continue;
      const held = venuePositions.find((p) => p.symbol === pos.contract.symbol);
      if (held && Math.abs(held.qty - pos.qty) > EPS) {
        this.journal(underlying, 'RECONCILE_QTY', { contract: pos.contract.symbol, tracked: pos.qty, venue: held.qty });
        this.deps.log('warn', `${underlying}: ${pos.contract.symbol} tracked qty ${pos.qty}, venue holds ${held.qty}; using the venue's`);
        pos.qty = held.qty;
      }
    }
    const tracked = this.trackedSymbols();
    for (const held of venuePositions) {
      if (tracked.has(held.symbol)) continue;
      const parsed = parseOptionSymbol(held.symbol);
      if (!parsed || !this.cfg.underlyings.includes(parsed.underlying)) {
        this.deps.log('warn', `venue holds ${held.qty} ${held.symbol}, outside the configured underlyings; not managed`);
        continue;
      }
      const slot = this.slot(parsed.underlying);
      if (slot.state !== 'IDLE') {
        this.deps.log('error', `venue holds ${held.qty} ${held.symbol} but ${parsed.underlying} is ${slot.state}; not adopted — close it on the venue`);
        continue;
      }
      const contract = (await this.deps.chain.contractsFor(parsed.underlying)).find((c) => c.symbol === held.symbol);
      if (!contract) {
        this.deps.log('error', `venue holds ${held.qty} ${held.symbol}, which is no longer listed; not adopted`);
        continue;
      }
      slot.position = {
        contract,
        qty: held.qty,
        entryPrice: held.avgPrice,
        entryFee: 0,
        entryClientOrderId: `adopted-${held.symbol}-${this.newId()}`,
        leg: {
          right: contract.right,
          entryPrice: held.avgPrice,
          stopPremium: held.avgPrice * (1 - this.cfg.exits.stopPct / 100),
          targetPremium: held.avgPrice * (1 + this.cfg.exits.targetPct / 100),
          peakBid: held.avgPrice,
          trailActive: false,
          openedAt: now,
          expiryMs: contract.expiryMs,
        },
        exitAttempts: 0,
        closedQty: 0,
        exitProceeds: 0,
        exitFees: 0,
      };
      this.fire(parsed.underlying, 'ADOPT');
      this.journal(parsed.underlying, 'ADOPTED', { contract: held.symbol, qty: held.qty, avgPrice: held.avgPrice });
      this.deps.log('warn', `${parsed.underlying}: adopted untracked ${held.qty} ${held.symbol} @ ${held.avgPrice}; stop/target anchored to its average price`);
    }
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------

  private async currentDirection(underlying: string): Promise<OptionRight | null> {
    try {
      const ctx = await this.deps.context.context(underlying);
      return directionFor(ctx.marketState, ctx.candles1h, this.cfg.direction).right;
    } catch {
      // No fresh read means no thesis verdict; price and time exits still run.
      return null;
    }
  }

  private reject(underlying: string, reasons: string[]): void {
    this.journal(underlying, 'ENTRY_REJECTED', { reasons });
    this.fire(underlying, 'REJECT');
    this.note(underlying, `rejected: ${reasons.slice(0, 2).join('; ')}`);
  }

  private exposure(): OpenExposure {
    let premiumAtRisk = 0;
    let openPositions = 0;
    for (const slot of Object.values(this.state.slots)) {
      if (slot.position) {
        premiumAtRisk += slot.position.qty * slot.position.entryPrice;
        openPositions += 1;
      } else if (slot.pendingEntry) {
        premiumAtRisk += slot.pendingEntry.qty * slot.pendingEntry.limitPrice;
        openPositions += 1;
      }
    }
    return { premiumAtRisk, openPositions };
  }

  private trackedSymbols(): Set<string> {
    const out = new Set<string>();
    for (const slot of Object.values(this.state.slots)) if (slot.position) out.add(slot.position.contract.symbol);
    return out;
  }

  private vetoSnapshot(underlying: string, selection: Selection, plan: EntryPlan, spot: number, realizedVol: number, marketState: MarketState): OptionVetoSnapshot {
    const { contract, greeks, mark } = selection.screened;
    const e = selection.economics;
    return {
      underlying,
      contract: contract.symbol,
      right: contract.right,
      spot,
      strike: contract.strike,
      hoursToExpiry: Number(((contract.expiryMs - this.now()) / 3_600_000).toFixed(1)),
      premium: e.ask,
      spreadPct: Number(e.spreadPct.toFixed(2)),
      delta: Number(greeks.delta.toFixed(3)),
      thetaPerDay: Number(greeks.thetaPerDay.toFixed(4)),
      impliedVolPct: Number(((mark.markIv ?? 0) * 100).toFixed(1)),
      realizedVolPct: Number((realizedVol * 100).toFixed(1)),
      ivRvRatio: Number(e.ivRvRatio.toFixed(2)),
      breakevenMovePct: Number(e.breakevenMovePct.toFixed(3)),
      edgeRatio: Number(e.edgeRatio.toFixed(2)),
      regime: marketState.regime.regime,
      htfTrend: marketState.htfStructure.trend,
      rsi15m: marketState.timeframes['15m']?.rsi14 ?? null,
      stopPremium: plan.stopPremium,
      targetPremium: plan.targetPremium,
      quantity: plan.qty,
      maxLossUsdt: Number(plan.plannedLoss.toFixed(2)),
    };
  }

  private slot(underlying: string): UnderlyingSlot {
    return (this.state.slots[underlying] ??= emptySlot(this.now()));
  }

  private fire(underlying: string, event: OptionTradeEvent): void {
    const slot = this.slot(underlying);
    slot.state = transition(slot.state, event);
    slot.updatedAt = this.now();
  }

  private note(underlying: string, text: string): void {
    this.notes.set(underlying, text);
  }

  private journal(underlying: string, event: string, data: Record<string, unknown>): void {
    this.deps.journal.append({ ts: this.now(), underlying, event, ...data });
  }

  private persist(): void {
    this.state.riskBook = this.riskBook?.snapshot() ?? null;
    if (isPersistentVenue(this.deps.venue)) this.state.localVenue = this.deps.venue.exportState();
    this.deps.store.save(this.state);
  }
}
