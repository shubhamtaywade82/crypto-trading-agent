import { USDMClient, WebsocketClient } from 'binance';
import { MarketDataService, DEFAULT_MARKET_DATA_OPTIONS } from '../src/market/MarketDataService.js';
import { MiniCpmService } from '../src/minicpm/MiniCpmService.js';
import { SymbolTraderWorker } from '../src/minicpm/SymbolTraderWorker.js';
import { renderDashboard } from '../src/minicpm/MiniCpmDashboard.js';
import { config } from '../src/config.js';

const PAPER_URL = process.env.PAPER_EXCHANGE_URL || 'http://127.0.0.1:3100';
const API_KEY = process.env.PAPER_EXCHANGE_API_KEY || 'b9a74aa1e560e92842e308e40391044968709d39c03e97c40d0b39f4eb8f7242';
const SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const ANCHOR = 'BTCUSDT';
const ALL_SYMBOLS = [ANCHOR, ...SYMBOLS];

async function main() {
  console.log('Initializing Real-Time MiniCPM-2B Multi-Symbol Trader Fleet...');

  const futuresClient = new USDMClient({
    api_key: config.binance.apiKey,
    api_secret: config.binance.apiSecret,
  });

  const marketData = new MarketDataService(futuresClient, DEFAULT_MARKET_DATA_OPTIONS);
  const llm = new MiniCpmService({
    host: 'http://127.0.0.1:11434',
    model: 'openbmb/minicpm5-2b:latest',
  });

  const workers = new Map<string, SymbolTraderWorker>();
  for (const symbol of SYMBOLS) {
    const symKey = symbol.replace('USDT', '').toLowerCase();
    const worker = new SymbolTraderWorker(
      {
        symbol,
        accountId: `crypto-minicpm-${symKey}`,
        paperExchangeUrl: PAPER_URL,
        apiKey: API_KEY,
        marginPerPosition: 1000,
        leverage: 10,
      },
      llm,
    );
    await worker.syncAccount();
    workers.set(symbol, worker);
  }

  const startTime = Date.now();
  console.log('Connecting real-time Binance WebSocket feeds...');

  // Protect process from unhandled rejections/exceptions so it runs 24/7 uninterrupted
  process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
  process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

  // Setup live websocket stream for sub-second updates and instant SL/TP execution
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
      renderDashboard(startTime, statuses);
    }
  };

  ws.on('message', async (data: any) => {
    if (data?.e === 'trade' && data.s && Number(data.p) > 0) {
      const symbol = data.s;
      const price = Number(data.p);
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

  // 1-second continuous TUI tick timer for uptime / clock
  const renderInterval = setInterval(triggerRender, 1000);

  let running = true;
  process.on('SIGINT', () => {
    running = false;
    clearInterval(renderInterval);
    ws.closeAll();
  });
  process.on('SIGTERM', () => {
    running = false;
    clearInterval(renderInterval);
    ws.closeAll();
  });

  console.log('Real-time feed active. Starting background LLM evaluation loop...');

  // Background market candle & LLM evaluation loop (runs concurrently with real-time websocket)
  while (running) {
    try {
      const snapshots = await marketData.snapshot(ALL_SYMBOLS);

      const btcSnapshot = snapshots[ANCHOR];
      const btc15m = btcSnapshot?.candles['15m'] ?? [];
      const btc1h = btcSnapshot?.candles['1h'] ?? [];

      for (const symbol of SYMBOLS) {
        const snap = snapshots[symbol];
        if (!snap) continue;

        const sym15m = snap.candles['15m'] ?? [];
        const sym1h = snap.candles['1h'] ?? [];
        const markPrice = sym15m.at(-1)?.close;

        if (markPrice && btc15m.length > 0) {
          const worker = workers.get(symbol);
          if (worker) {
            await worker.evaluate(markPrice, btc15m, btc1h, sym15m, sym1h);
          }
        }
      }
      triggerRender();
    } catch (err) {
      console.error('[Fleet Loop Error]:', (err as Error).message);
    }

    // Small delay between full multi-candle LLM sweeps
    await new Promise((r) => setTimeout(r, 10_000));
  }

  console.log('\nShutdown gracefully.');
}

main().catch(console.error);
