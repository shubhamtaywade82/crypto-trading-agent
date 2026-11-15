import type { TradingEvent } from '../events/TradingEvent.js';

/** Append-only record of everything the engine decided and did. */
export interface ResearchRepository {
  append(event: TradingEvent): void;
}
