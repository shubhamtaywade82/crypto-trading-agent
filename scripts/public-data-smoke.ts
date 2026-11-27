/**
 * Live, read-only check of the public market-data feeds on mainnet: Spot and USDⓈ-M top-of-book over WebSocket, and the
 * funding-rate REST. It sends no order and uses no key. Exits 1 when no book became LIVE within the window.
 *
 *   npm run public-data:smoke                     # window: PUBLIC_SMOKE_SECONDS (default 15)
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { PublicMarketFeeds } from '../src/market/public/PublicMarketFeeds.js';
import type { PublicQuote } from '../src/market/public/types.js';

const seconds = Number(process.env.PUBLIC_SMOKE_SECONDS ?? 15);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('PUBLIC_SMOKE_SECONDS must be a positive number');
  process.exit(2);
}

const feeds = new PublicMarketFeeds({
  symbols: config.symbols,
  spot: true,
  usdmExtras: true,
  staleMs: config.publicData.staleMs,
  fundingRefreshMs: config.publicData.fundingRefreshMs,
  log: (message, level) => console.log(`[${level}] ${message}`),
});

await feeds.start();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const ctx = feeds.snapshot();
feeds.stop();

const liveCount = (quotes: Readonly<Record<string, PublicQuote>>): number =>
  Object.values(quotes).filter((quote) => quote.quality === 'LIVE').length;
const spotLive = liveCount(ctx.spot);
const usdmLive = liveCount(ctx.usdm);

console.log(JSON.stringify({
  windowSeconds: seconds,
  spotLive,
  usdmLive,
  basisBps: ctx.basisBps,
  funding: Object.fromEntries(Object.entries(ctx.funding).map(([symbol, f]) => [symbol, { lastRate: f.lastRate, lastFundingTime: f.lastFundingTime }])),
}, null, 2));

process.exit(spotLive + usdmLive > 0 ? 0 : 1);
