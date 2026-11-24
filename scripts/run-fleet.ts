import { WebsocketClient } from 'binance';
import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { MarketDataService, DEFAULT_MARKET_DATA_OPTIONS } from '../src/market/MarketDataService.js';
import { SdkFuturesMarketClient } from '../src/market/SdkFuturesMarketClient.js';
import { KlineStreamCache, DEFAULT_KLINE_MAX_SILENCE_MS } from '../src/market/KlineStreamCache.js';
import { KlineStreamFeed } from '../src/market/KlineStreamFeed.js';
import { KLINE_INTERVALS } from '../src/market/klineIntervals.js';
import { usdmWsRouteBases } from '../src/binance/wsRoutes.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import { FleetLlmService } from '../src/fleet/FleetLlmService.js';
import { SymbolTraderWorker } from '../src/fleet/SymbolTraderWorker.js';
import { PaperExchangeLeaseAdapter } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseAdapter.js';
import { DEFAULT_LEASE_TTL_SECONDS, PaperExchangeLeaseKeeper } from '../src/core/adapters/paper-exchange/PaperExchangeLeaseKeeper.js';
import { renderDashboard } from '../src/fleet/FleetDashboard.js';
import { resolveFleetPaperExchange, type FleetPaperExchange } from '../src/fleet/fleetPaperExchange.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  lookupModelByTag,
  parseModelRoute,
  resolveFleetModelAssignment,
  type FleetModelAssignment,
} from '../src/fleet/FleetModels.js';
import { fleetTelegramEnabled, sendFleetEvent } from '../src/fleet/FleetTelegram.js';
import { config } from '../src/config.js';
import { FLEET_ANCHOR, FLEET_CONTEXT_SYMBOLS, FLEET_SYMBOLS } from '../src/fleet/FleetSupervisor.js';

const SYMBOLS: string[] = [...FLEET_SYMBOLS];
const ANCHOR = FLEET_ANCHOR;
const ALL_SYMBOLS = [ANCHOR, ...SYMBOLS, ...FLEET_CONTEXT_SYMBOLS];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main() {
  // Refuse to start without the broker token, before any broker or market-feed call.
  let paperExchange: FleetPaperExchange;
  try {
    paperExchange = resolveFleetPaperExchange(process.env);
  } catch (err) {
    console.error(`[fleet] ${(err as Error).message}`);
    process.exit(1);
  }

  // Model selection: fleet default (--model / FLEET_MODEL) plus per-symbol overrides
  // (--route 'ETH=qwen3.5:2b,SOL=lfm2.5-2.6b' / FLEET_MODEL_ROUTE). Registry ids and raw
  // Ollama tags are both accepted. A route naming an untraded symbol fails at boot.
  const modelSpec = argValue('--model') ?? process.env.FLEET_MODEL ?? config.ollama.model;
  const routeSpec = argValue('--route') ?? process.env.FLEET_MODEL_ROUTE;
  const llmHost = argValue('--host') ?? process.env.FLEET_LLM_HOST ?? config.ollama.host;
  const timeoutMs = Number.parseInt(argValue('--timeout-ms') ?? process.env.FLEET_LLM_TIMEOUT_MS ?? '', 10) || DEFAULT_LLM_TIMEOUT_MS;

  let assignment: FleetModelAssignment;
  try {
    assignment = resolveFleetModelAssignment({
      symbols: SYMBOLS,
      defaultSpec: modelSpec,
      ...(routeSpec ? { route: parseModelRoute(routeSpec) } : {}),
    });
  } catch (err) {
    console.error(`[fleet] model selection refused: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('Initializing Real-Time Multi-Model Trader Fleet (Ollama Cloud, default: beam)...');
  console.log(`  LLM host: ${llmHost} · timeout: ${timeoutMs}ms`);
  for (const symbol of SYMBOLS) {
    const tag = assignment.bySymbol[symbol];
    const meta = lookupModelByTag(tag);
    const metaNote = meta ? ` (${meta.label}, ${meta.role})` : '';
    console.log(`  ${symbol}: ${tag}${metaNote}`);
  }
  // Tags outside the curated shortlist are allowed (custom models), but a typo that happens to
  // look like a tag would otherwise degrade silently at request time — surface it at boot.
  for (const tag of assignment.distinctTags) {
    if (!lookupModelByTag(tag)) {
      console.warn(`  WARNING: '${tag}' is not in the curated shortlist — if this is a typo, the daemon will 404 and every decision becomes "No setup approved". Verify with: ollama list | grep ${tag}`);
    }
  }

  const entriesEnabled = process.env.FLEET_ENTRIES === 'on' || process.argv.includes('--enable-entries');
  console.log(`  Entries: ${entriesEnabled ? 'ARMED (risk-gated)' : 'OFF (shadow analysis, R1)'}`);
  // [FLEET] Telegram cards per worker buy/sell/exit — same bot config as the main agent, tagged
  // and routed around its alert pipeline. FLEET_TELEGRAM=off is the opt-out.
  console.log(`  Telegram: ${fleetTelegramEnabled(process.env) ? 'trade notifications ON ([FLEET] buy/sell/exit cards per worker)' : 'OFF (FLEET_TELEGRAM=off)'}`);

  // Public market data goes through the SDK, which tracks its own per-host weight. Candles come from
  // the kline stream once it has backfilled.
  const sdkMarket = new SdkFuturesMarketClient(new BinanceClient().futures);

  const klineCache = new KlineStreamCache({ limit: DEFAULT_MARKET_DATA_OPTIONS.klineLimit, maxSilenceMs: DEFAULT_KLINE_MAX_SILENCE_MS });
  const marketData = new MarketDataService(sdkMarket, DEFAULT_MARKET_DATA_OPTIONS, klineCache);
  const klineFeed = new KlineStreamFeed({
    marketBase: usdmWsRouteBases('live').market,
    symbols: ALL_SYMBOLS,
    intervals: KLINE_INTERVALS,
    limit: DEFAULT_MARKET_DATA_OPTIONS.klineLimit,
    cache: klineCache,
    backfill: (symbol, interval, limit) => sdkMarket.getKlines({ symbol, interval, limit }),
    log: (message, level) => console[level === 'warn' ? 'warn' : 'log'](`[kline feed] ${message}`),
  });
  const marketStateBuilder = new MarketStateBuilder();
  // One service per worker so per-symbol model routing stays local to its worker. The service is
  // model-agnostic: any Ollama tag works, the prompt/validation contract is identical for every model.

  const workers = new Map<string, SymbolTraderWorker>();
  const leases: PaperExchangeLeaseKeeper[] = [];
  for (const symbol of SYMBOLS) {
    const symKey = symbol.replace('USDT', '').toLowerCase();
    const modelTag = assignment.bySymbol[symbol];
    const llm = new FleetLlmService({ host: llmHost, model: modelTag, timeoutMs, apiKeys: config.ollama.apiKeys, fallback: config.ollama.fallback });
    const accountId = `crypto-fleet-${symKey}`;
    // Each worker trades its own account. Its lease is taken before the first write, because syncAccount can create the account.
    // A lease another process holds stops this fleet at startup: two writers on one account is the failure the lease prevents.
    const keeper = new PaperExchangeLeaseKeeper({
      lease: new PaperExchangeLeaseAdapter({ baseUrl: paperExchange.url, apiKey: paperExchange.apiKey, ttlSeconds: DEFAULT_LEASE_TTL_SECONDS }),
      accountId,
      label: `standalone fleet pid ${process.pid} ${symKey}`,
      ttlSeconds: DEFAULT_LEASE_TTL_SECONDS,
      log: (message) => console.warn(`[fleet lease] ${message}`),
    });
    try {
      await keeper.start();
    } catch (error) {
      console.error(`refusing to start: ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
      await Promise.allSettled(leases.map((held) => held.stop()));
      process.exit(1);
    }
    leases.push(keeper);
    const worker = new SymbolTraderWorker(
      {
        symbol,
        accountId,
        paperExchangeUrl: paperExchange.url,
        apiKey: paperExchange.apiKey,
        marginPerPosition: 1000,
        leverage: 10,
        riskPerTradePct: config.risk.riskPerTradePct,
        entriesEnabled,
        modelTag,
        lease: keeper,
        onTradeEvent: (event) => {
          void sendFleetEvent(event).catch(() => undefined);
        },
      },
      llm,
    );
    await worker.syncAccount();
    workers.set(symbol, worker);
  }

  const startTime = Date.now();
  console.log('Connecting real-time Binance WebSocket feeds...');

  // State cache for dashboard macro header
  let btcPrice = 0;
  let btcTrend1h = 'SIDEWAYS';
  let btcTrend15m = 'SIDEWAYS';
  let btcChange24h = 0;

  process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
  process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

  const silent = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
  const ws = new WebsocketClient({ beautify: false }, silent as any);
  ws.on('error', (err: any) => console.error('[Binance WS Error]:', err?.message || err));
  ws.on('reconnecting', () => console.warn('[Binance WS]: Reconnecting...'));
  ws.on('reconnected', () => console.log('[Binance WS]: Reconnected successfully.'));

  let lastDashboardRender = 0;
  const triggerRender = () => {
    const now = Date.now();
    // Throttle UI re-render to max 4 times per second (250ms) to prevent console tearing
    if (now - lastDashboardRender > 250) {
      lastDashboardRender = now;
      const statuses = Array.from(workers.values()).map((w) => w.getStatus());
      renderDashboard({
        startTime,
        btcPrice,
        btcTrend1h,
        btcTrend15m,
        btcChange24h,
        workers: statuses,
        entriesEnabled,
      });
    }
  };

  ws.on('message', async (data: any) => {
    if (data?.e === 'trade' && data.s && Number(data.p) > 0) {
      const symbol = data.s;
      const price = Number(data.p);

      if (symbol === ANCHOR) {
        btcPrice = price;
      }

      const worker = workers.get(symbol);
      if (worker) {
        await worker.onLiveTick(price);
        triggerRender();
      }
    }
  });

  for (const sym of ALL_SYMBOLS) {
    ws.subscribeTrades(sym, 'usdm');
  }
  klineFeed.start();

  const renderInterval = setInterval(triggerRender, 1000);

  let running = true;
  // The renewal timers keep the process alive, so the leases are released before the loop can end.
  process.on('SIGINT', () => {
    running = false;
    clearInterval(renderInterval);
    klineFeed.stop();
    ws.closeAll();
    void Promise.allSettled(leases.map((lease) => lease.stop()));
  });
  process.on('SIGTERM', () => {
    running = false;
    clearInterval(renderInterval);
    klineFeed.stop();
    ws.closeAll();
    void Promise.allSettled(leases.map((lease) => lease.stop()));
  });

  console.log('Real-time feed active. Starting background LLM evaluation loop...');

  while (running) {
    try {
      const snapshots = await marketData.snapshot(ALL_SYMBOLS);

      const btcSnapshot = snapshots[ANCHOR];
      const btc15m = btcSnapshot?.candles['15m'] ?? [];
      const btc1h = btcSnapshot?.candles['1h'] ?? [];

      if (btc15m.length > 0) {
        const last = btc15m.at(-1)!;
        btcPrice = last.close;
        const open24h = btc1h.length >= 24 ? btc1h.at(-24)!.open : btc1h[0]?.open ?? last.close;
        btcChange24h = ((last.close - open24h) / open24h) * 100;

        const diff1h = btc1h.length >= 5 ? ((last.close - btc1h.at(-5)!.close) / btc1h.at(-5)!.close) * 100 : 0;
        btcTrend1h = diff1h > 0.3 ? 'BULLISH' : diff1h < -0.3 ? 'BEARISH' : 'SIDEWAYS';

        const diff15m = btc15m.length >= 5 ? ((last.close - btc15m.at(-5)!.close) / btc15m.at(-5)!.close) * 100 : 0;
        btcTrend15m = diff15m > 0.2 ? 'BULLISH' : diff15m < -0.2 ? 'BEARISH' : 'SIDEWAYS';
      }

      const peerCandles1h = Object.fromEntries(FLEET_CONTEXT_SYMBOLS.map((s) => [s, snapshots[s]?.candles['1h'] ?? []]));
      for (const symbol of SYMBOLS) {
        const snap = snapshots[symbol];
        if (!snap) continue;

        const sym15m = snap.candles['15m'] ?? [];
        const sym1h = snap.candles['1h'] ?? [];
        const sym4h = snap.candles['4h'] ?? [];
        const markPrice = sym15m.at(-1)?.close;

        if (markPrice && btc15m.length > 0) {
          const worker = workers.get(symbol);
          if (worker) {
            // Build rich MarketState so the LLM receives regime/structure/liquidity facts
            const marketState = sym15m.length >= 50 ? marketStateBuilder.build({
              symbol,
              candles: sym15m,
              candlesByTimeframe: { '15m': sym15m, '1h': sym1h, '4h': sym4h },
              mark: markPrice,
              fundingRate: 0,
              derivatives: snap.derivatives ?? null,
            }) : undefined;
            await worker.evaluate({
              markPrice,
              btcCandles15m: btc15m,
              btcCandles1h: btc1h,
              symbolCandles15m: sym15m,
              symbolCandles1h: sym1h,
              marketState,
              peerCandles1h,
            });
          }
        }
      }

      triggerRender();
    } catch (err) {
      console.error('[Fleet Loop Error]:', (err as Error).message);
    }

    await new Promise((r) => setTimeout(r, 10_000));
  }

  console.log('\nShutdown gracefully.');
}

main().catch(console.error);
