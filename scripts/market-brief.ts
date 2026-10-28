/**
 * Live market brief for one Binance USDⓈ-M perpetual: a read-only, one-shot snapshot structured
 * for a human trade/no-trade decision — price and 24h stats, multi-timeframe structure on
 * confirmed candles, derivatives/positioning/order flow, support/resistance zones, conditional
 * scenarios, an explicit no-entry band, and comparison against recorded snapshots.
 *
 *   npm run brief -- [--symbol SOLUSDT] [--compare 2026-10-21,2026-10-25] [--data-dir data/market]
 *                    [--out data/briefs] [--json]
 *
 * Public endpoints only: no API keys, no orders, no writes outside --out. Recorded history comes
 * from scripts/record-market-data.ts output; without it, section 7 says so instead of estimating.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { USDMClient } from 'binance';
import { collectBriefMarketData } from '../src/brief/MarketBriefData.js';
import { buildMarketBrief, DEFAULT_BRIEF_BUILD_OPTIONS } from '../src/brief/MarketBriefBuilder.js';
import { renderBriefMarkdown } from '../src/brief/render.js';
import { loadMinutes } from '../src/marketdata/loadMinutes.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const symbol = (arg('symbol') ?? 'SOLUSDT').toUpperCase();
  const compare = arg('compare');
  const out = arg('out');
  const dataDir = arg('data-dir') ?? 'data/market';
  const json = arg('json') !== undefined;

  const client = new USDMClient();
  const data = await collectBriefMarketData(symbol, client);
  const history = loadMinutes(dataDir, symbol);

  const brief = buildMarketBrief(data, {
    ...DEFAULT_BRIEF_BUILD_OPTIONS,
    history,
    compareDates: compare?.split(',').map((d) => d.trim()).filter(Boolean),
  });
  const markdown = renderBriefMarkdown(brief);

  console.log(markdown);
  if (json) console.log(JSON.stringify(brief, null, 2));

  if (out) {
    mkdirSync(out, { recursive: true });
    const stamp = new Date(brief.generatedAt).toISOString().replace(/[:.]/g, '-');
    const file = path.join(out, `${symbol}-brief-${stamp}.md`);
    writeFileSync(file, markdown + '\n');
    console.error(`brief written to ${file}`);
  }
}

main().catch((err) => {
  console.error('market brief failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
