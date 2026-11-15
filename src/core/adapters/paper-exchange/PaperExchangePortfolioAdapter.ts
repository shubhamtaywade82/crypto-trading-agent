import type { PositionView } from '../../domain/portfolio.js';
import { VenueUnavailableError } from '../../ports/PaperExecutionPort.js';
import type { AccountView, PortfolioPort } from '../../ports/PortfolioPort.js';
import { translating, type PaperExchangeApi } from './PaperExchangeApi.js';

/** Account, positions and each position's protective stop, read from the broker on every call. Nothing is cached. */
export class PaperExchangePortfolioAdapter implements PortfolioPort {
  constructor(private readonly api: PaperExchangeApi) {}

  getAccount(asOf: number): Promise<AccountView> {
    return translating(async () => {
      const [account, positions] = await Promise.all([this.api.getAccount(), this.api.getPositions()]);
      if (!account) throw new VenueUnavailableError('paper_exchange has no account for the configured account id');
      const views = await Promise.all(positions.map(async (p): Promise<PositionView> => {
        const stop = (await this.api.listProtections(p.id)).find((protection) => protection.type === 'stop_loss' && protection.status === 'active');
        return {
          symbol: p.symbol, direction: p.side === 'long' ? 'LONG' : 'SHORT', quantity: p.netQuantity, entryPrice: p.averagePrice,
          markPrice: p.currentPrice, leverage: p.leverage, unrealizedPnl: p.unrealizedPnl, stopLoss: stop?.triggerPrice ?? null,
        };
      }));
      return { asOf, equity: account.equity, availableMargin: account.availableBalance, realizedPnl: account.realizedPnl, positions: views };
    });
  }
}
