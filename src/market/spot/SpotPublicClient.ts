import { PublicRestClient } from '../public/PublicRestClient.js';
import { BookTickerRest, parsePositive, SpotExchangeInfoRest } from '../public/parsers.js';

export interface SpotBookBootstrap {
  readonly symbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
}

/** Keyless Spot reads from data-api.binance.vision, through the guarded REST client. */
export class SpotPublicClient {
  constructor(private readonly rest: PublicRestClient) {}

  /** The subset of `symbols` whose status is TRADING on the venue. Unknown symbols are left out, not assumed live. */
  async tradingSymbols(symbols: readonly string[]): Promise<Set<string>> {
    const body = SpotExchangeInfoRest.parse(await this.rest.getJson('spot.exchangeInfo'));
    const wanted = new Set(symbols.map((s) => s.toUpperCase()));
    return new Set(body.symbols.filter((s) => s.status === 'TRADING' && wanted.has(s.symbol)).map((s) => s.symbol));
  }

  async bookTicker(symbol: string): Promise<SpotBookBootstrap> {
    const body = BookTickerRest.parse(await this.rest.getJson('spot.bookTicker', { symbol: symbol.toUpperCase() }));
    return { symbol: body.symbol, bid: parsePositive(body.bidPrice), ask: parsePositive(body.askPrice) };
  }
}
