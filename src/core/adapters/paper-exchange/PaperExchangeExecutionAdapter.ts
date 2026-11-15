import type { PaperExchangePosition, SubmitOrderResult } from '../../../binance/paperExchangeClient.js';
import type { PlaceOrderCommand } from '../../domain/execution.js';
import type { MarkSinkPort } from '../../ports/MarkFeedPort.js';
import {
  VenueRejectedError, VenueUnavailableError, type OwnedPosition, type PaperExecutionPort, type SlotView, type VenueOrderAck,
} from '../../ports/PaperExecutionPort.js';
import { translating, type PaperExchangeApi } from './PaperExchangeApi.js';

const sideOf = (command: PlaceOrderCommand): 'buy' | 'sell' => (command.side === 'BUY' ? 'buy' : 'sell');

/**
 * A filled or partially-filled ack must state how much actually filled: the journal records this number as the fill, so
 * a missing or non-positive quantity is an unknowable outcome (reconcile via findOrder) — never the requested quantity
 * as a guess, which would book a fill the venue never confirmed. An over-fill is equally unknowable bookkeeping drift.
 */
function reportedFill(result: SubmitOrderResult, atMost?: number): number {
  const filled = result.filledQuantity;
  if (filled === undefined || !Number.isFinite(filled) || filled <= 0) {
    throw new VenueUnavailableError(`paper_exchange order ${result.orderId} is ${result.status} without a usable filled_quantity`);
  }
  if (atMost !== undefined && filled > atMost) {
    throw new VenueUnavailableError(`paper_exchange order ${result.orderId} reports fill ${filled} against a request of ${atMost}`);
  }
  return filled;
}

/** The venue must be talking about this submission: a client_order_id echo that disagrees means an unknown outcome. */
function assertEcho(expectedKey: string, result: SubmitOrderResult): void {
  if (result.clientOrderId !== undefined && result.clientOrderId !== expectedKey) {
    throw new VenueUnavailableError(`paper_exchange order ${result.orderId} carries client_order_id ${result.clientOrderId}, not ${expectedKey}`);
  }
}

function toAck(command: PlaceOrderCommand, result: SubmitOrderResult): VenueOrderAck {
  assertEcho(command.idempotencyKey, result);
  const base = { venueOrderId: String(result.orderId), averagePrice: null, protectionCarried: false };
  switch (result.status) {
    case 'filled': return { ...base, status: 'FILLED', filledQuantity: reportedFill(result, command.quantity) };
    case 'partially_filled': return { ...base, status: 'PARTIALLY_FILLED', filledQuantity: reportedFill(result, command.quantity) };
    case 'rejected':
    case 'cancelled': throw new VenueRejectedError(`paper_exchange order ${result.orderId} came back ${result.status}`);
    // A market order that is neither filled nor refused is in a state this adapter cannot vouch for
    default: throw new VenueUnavailableError(`paper_exchange order ${result.orderId} came back ${result.status}`);
  }
}

/**
 * Agent-driven paper execution for one account. The order carries the reference price the decision was made on and the
 * broker fills it there. That is a mark, not an executable bid or ask, so fills on this path flatter a strategy relative to
 * a real book; use the replay path for research.
 *
 * Every position is addressed by its slot id. A symbol is only used to read the slot, and only after the adapter has
 * checked that the slot belongs to this account.
 */
export class PaperExchangeExecutionAdapter implements PaperExecutionPort, MarkSinkPort {
  readonly venue = 'paper_exchange' as const;

  constructor(private readonly api: PaperExchangeApi, readonly accountId: string) {
    if (!accountId.trim()) throw new Error('the paper_exchange execution adapter needs an account');
  }

  async submitOrder(command: PlaceOrderCommand): Promise<VenueOrderAck> {
    this.assertAccount(command.accountId, `command ${command.commandId}`);
    return translating(async () => toAck(command, await this.api.submitOrder({
      symbol: command.symbol, side: sideOf(command), quantity: command.quantity, leverage: command.leverage,
      executionPrice: command.referencePrice, clientOrderId: command.idempotencyKey,
    })));
  }

  async findOrder(idempotencyKey: string): Promise<VenueOrderAck | null> {
    return translating(async () => {
      const found = await this.api.findOrder(idempotencyKey);
      if (!found) return null;
      if (found.status === 'filled') return { venueOrderId: String(found.orderId), status: 'FILLED', filledQuantity: reportedFill(found), averagePrice: null, protectionCarried: false };
      if (found.status === 'partially_filled') return { venueOrderId: String(found.orderId), status: 'PARTIALLY_FILLED', filledQuantity: reportedFill(found), averagePrice: null, protectionCarried: false };
      if (found.status === 'rejected' || found.status === 'cancelled') throw new VenueRejectedError(`paper_exchange order ${found.orderId} is ${found.status}`);
      throw new VenueUnavailableError(`paper_exchange order ${found.orderId} is ${found.status}`);
    });
  }

  async readSlot(symbol: string): Promise<SlotView> {
    return translating(async () => {
      // A perpetual slot is unique per account and symbol on the venue. Two open rows would mean the venue's invariant broke.
      const matches = (await this.api.getPositions()).filter((p) => p.symbol === symbol);
      if (matches.length > 1) throw new VenueUnavailableError(`${symbol} has ${matches.length} open rows in account ${this.accountId}; a perpetual slot must be unique`);
      const [open] = matches;
      return open ? { symbol, slotId: open.id, quantity: open.netQuantity } : { symbol, slotId: null, quantity: 0 };
    });
  }

  /** Creates whichever of the stop and target the owned position does not already have, so a repeat call adds nothing. */
  async protect(command: PlaceOrderCommand, owned: OwnedPosition): Promise<void> {
    this.assertOwned(owned, command.symbol);
    return translating(async () => {
      const position = await this.openSlot(owned);
      const active = new Set((await this.api.listProtections(position.id)).filter((p) => p.status === 'active').map((p) => p.type));
      if (!active.has('stop_loss')) await this.api.createProtection(position.id, 'stop_loss', command.stopLoss, position.netQuantity);
      if (!active.has('take_profit')) await this.api.createProtection(position.id, 'take_profit', command.takeProfit, position.netQuantity);
    });
  }

  /**
   * Reduce-only exit of the owned position. The venue sizes a reduce-only order by account and symbol, which is safe only
   * because the account's lease keeps this process the sole writer. The slot is re-read afterwards, and a slot that is still
   * open is reported rather than assumed closed.
   */
  async flatten(owned: OwnedPosition, reason: string): Promise<void> {
    this.assertOwned(owned, owned.symbol);
    return translating(async () => {
      const position = await this.optionalSlot(owned);
      if (!position) return;
      const result = await this.api.submitOrder({
        symbol: owned.symbol, side: position.side === 'long' ? 'sell' : 'buy', quantity: position.netQuantity, leverage: position.leverage,
        reduceOnly: true, executionPrice: position.currentPrice > 0 ? position.currentPrice : position.averagePrice,
        clientOrderId: `${owned.episodeId}-flat`,
      });
      assertEcho(`${owned.episodeId}-flat`, result);
      if (result.status !== 'filled') throw new VenueUnavailableError(`flatten of ${owned.symbol} (${reason}) came back ${result.status}`);
      const left = await this.readSlot(owned.symbol);
      if (left.quantity > 0) throw new VenueUnavailableError(`flatten of ${owned.symbol} (${reason}) left ${left.quantity} open`);
    });
  }

  pushMarks(marks: Readonly<Record<string, number>>): Promise<void> {
    return translating(() => this.api.pushMarkPrices({ ...marks }));
  }

  pushFunding(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void> {
    return translating(() => this.api.pushFundingEvent(symbol, fundingRate, markPrice, fundingTime));
  }

  private assertAccount(accountId: string, subject: string): void {
    if (accountId !== this.accountId) throw new VenueRejectedError(`${subject} targets account ${accountId}; this adapter is bound to ${this.accountId}`);
  }

  private assertOwned(owned: OwnedPosition, symbol: string): void {
    this.assertAccount(owned.accountId, `position ${owned.episodeId}`);
    if (owned.symbol !== symbol) throw new VenueRejectedError(`the owned position is ${owned.symbol}; the operation is for ${symbol}`);
  }

  /** The owned slot, which must still be open. A slot that is no longer open is refused, never re-targeted by symbol. */
  private async openSlot(owned: OwnedPosition): Promise<PaperExchangePosition> {
    const position = await this.optionalSlot(owned);
    if (!position) throw new VenueRejectedError(`owned slot ${owned.slotId} for ${owned.symbol} is no longer open`);
    return position;
  }

  private async optionalSlot(owned: OwnedPosition): Promise<PaperExchangePosition | null> {
    const position = (await this.api.getPositions()).find((p) => p.id === owned.slotId);
    if (!position) return null;
    if (position.symbol !== owned.symbol) throw new VenueRejectedError(`slot ${owned.slotId} holds ${position.symbol}, not ${owned.symbol}`);
    return position;
  }
}
