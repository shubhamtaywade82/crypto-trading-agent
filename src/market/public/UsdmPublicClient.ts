import { FundingRateRest, parseFinite } from './parsers.js';
import type { PublicRestClient } from './PublicRestClient.js';
import type { UsdmFunding } from './types.js';

/** Keyless USDⓈ-M reads from fapi.binance.com, through the guarded REST client. */
export class UsdmPublicClient {
  constructor(private readonly rest: PublicRestClient) {}

  /**
   * The most recent `limit` funding rates for one symbol, oldest first. Rows whose rate fails to parse are dropped
   * rather than read as zero; a missing `lastRate` stays null.
   */
  async fundingHistory(symbol: string, limit: number, fetchedAt: number): Promise<UsdmFunding> {
    const rows = FundingRateRest.parse(await this.rest.getJson('usdm.fundingRate', { symbol: symbol.toUpperCase(), limit }));
    const parsed = rows
      .map((row) => ({ time: row.fundingTime, rate: parseFinite(row.fundingRate) }))
      .filter((row): row is { time: number; rate: number } => row.rate !== null)
      .sort((a, b) => a.time - b.time);
    const last = parsed.at(-1) ?? null;
    return {
      rates: parsed.map((row) => row.rate),
      lastFundingTime: last?.time ?? null,
      lastRate: last?.rate ?? null,
      fetchedAt,
    };
  }
}
