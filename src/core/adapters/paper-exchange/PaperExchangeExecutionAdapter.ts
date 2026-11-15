import type { SubmitOrderResult } from '../../../binance/paperExchangeClient.js';
import type { PlaceOrderCommand } from '../../domain/execution.js';
import type { MarkSinkPort } from '../../ports/MarkFeedPort.js';
import { VenueRejectedError, VenueUnavailableError, type PaperExecutionPort, type VenueOrderAck } from '../../ports/PaperExecutionPort.js';
import { translating, type PaperExchangeApi } from './PaperExchangeApi.js';

const sideOf = (command: PlaceOrderCommand): 'buy' | 'sell' => (command.side === 'BUY' ? 'buy' : 'sell');

function toAck(command: PlaceOrderCommand, result: SubmitOrderResult): VenueOrderAck {
  const base = { venueOrderId: String(result.orderId), averagePrice: null, protectionCarried: false };
  switch (result.status) {
    case 'filled': return { ...base, status: 'FILLED', filledQuantity: result.filledQuantity ?? command.quantity };
    case 'partially_filled': return { ...base, status: 'PARTIALLY_FILLED', filledQuantity: result.filledQuantity ?? 0 };
    case 'rejected':
    case 'cancelled': throw new VenueRejectedError(`paper_exchange order ${result.orderId} came back ${result.status}`);
    // A market order that is neither filled nor refused is in a state this adapter cannot vouch for
    default: throw new VenueUnavailableError(`paper_exchange order ${result.orderId} came back ${result.status}`);
  }
}

/**
 * Agent-driven paper execution: the order carries the reference price the decision was made on and the broker fills it
 * there. That is a mark, not an executable bid or ask, so fills on this path flatter a strategy relative to a real
 * book; use the replay path for research.
 */
export class PaperExchangeExecutionAdapter implements PaperExecutionPort, MarkSinkPort {
  readonly venue = 'paper_exchange' as const;

  constructor(private readonly api: PaperExchangeApi) {}

  submitOrder(command: PlaceOrderCommand): Promise<VenueOrderAck> {
    return translating(async () => toAck(command, await this.api.submitOrder({
      symbol: command.symbol, side: sideOf(command), quantity: command.quantity, leverage: command.leverage,
      executionPrice: command.referencePrice, clientOrderId: command.idempotencyKey,
    })));
  }

  findOrder(idempotencyKey: string): Promise<VenueOrderAck | null> {
    return translating(async () => {
      const found = await this.api.findOrder(idempotencyKey);
      if (!found) return null;
      const filled = found.filledQuantity ?? 0;
      if (found.status === 'filled') return { venueOrderId: String(found.orderId), status: 'FILLED', filledQuantity: filled, averagePrice: null, protectionCarried: false };
      if (found.status === 'partially_filled') return { venueOrderId: String(found.orderId), status: 'PARTIALLY_FILLED', filledQuantity: filled, averagePrice: null, protectionCarried: false };
      if (found.status === 'rejected' || found.status === 'cancelled') throw new VenueRejectedError(`paper_exchange order ${found.orderId} is ${found.status}`);
      throw new VenueUnavailableError(`paper_exchange order ${found.orderId} is ${found.status}`);
    });
  }

  /** Creates whichever of the stop and target the position does not already have, so a repeat call adds nothing. */
  protect(command: PlaceOrderCommand): Promise<void> {
    return translating(async () => {
      const position = (await this.api.getPositions()).find((p) => p.symbol === command.symbol);
      if (!position) throw new VenueRejectedError(`no open ${command.symbol} position to protect`);
      const active = new Set((await this.api.listProtections(position.id)).filter((p) => p.status === 'active').map((p) => p.type));
      if (!active.has('stop_loss')) await this.api.createProtection(position.id, 'stop_loss', command.stopLoss, position.netQuantity);
      if (!active.has('take_profit')) await this.api.createProtection(position.id, 'take_profit', command.takeProfit, position.netQuantity);
    });
  }

  flatten(command: PlaceOrderCommand, _reason: string): Promise<void> {
    return translating(async () => {
      const position = (await this.api.getPositions()).find((p) => p.symbol === command.symbol);
      if (!position) return;
      const result = await this.api.submitOrder({
        symbol: command.symbol, side: position.side === 'long' ? 'sell' : 'buy', quantity: position.netQuantity, leverage: position.leverage,
        reduceOnly: true, executionPrice: position.currentPrice > 0 ? position.currentPrice : command.referencePrice,
        clientOrderId: `${command.idempotencyKey}-flat`,
      });
      if (result.status !== 'filled') throw new VenueUnavailableError(`flatten of ${command.symbol} came back ${result.status}`);
    });
  }

  pushMarks(marks: Readonly<Record<string, number>>): Promise<void> {
    return translating(() => this.api.pushMarkPrices({ ...marks }));
  }

  pushFunding(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void> {
    return translating(() => this.api.pushFundingEvent(symbol, fundingRate, markPrice, fundingTime));
  }
}
