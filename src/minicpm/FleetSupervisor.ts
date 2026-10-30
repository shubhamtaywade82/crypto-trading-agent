import { EventEmitter } from 'node:events';
import { USDMClient, WebsocketClient } from 'binance';
import { MarketDataService, DEFAULT_MARKET_DATA_OPTIONS } from '../market/MarketDataService.js';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import { MiniCpmService } from './MiniCpmService.js';
import { SymbolTraderWorker, type WorkerStatus } from './SymbolTraderWorker.js';
import { resolveFleetPaperExchange } from './fleetPaperExchange.js';
import {
  DEFAULT_FLEET_MODEL_ID,
  DEFAULT_LLM_HOST,
  DEFAULT_LLM_TIMEOUT_MS,
  lookupModelByTag,
  parseModelRoute,
  resolveFleetModelAssignment,
} from './FleetModels.js';
import { config } from '../config.js';

/**
 * FleetSupervisor: the MiniCPM multi-model trader fleet embedded in the main `npm run dev` runtime.
 *
 * The standalone runner (`npm run fleet`) and this supervisor share the SAME worker code path
 * (SymbolTraderWorker + MiniCpmService + FleetModels), so embedded and standalone behavior are
 * identical by construction. The supervisor:
 *
 *   - runs its own Binance market-data snapshot loop and trade WebSocket (self-contained: hosting
 *     the fleet must not add a single code path to the main agent's decision loop);
 *   - is DISABLED, never fatal, when its prerequisites are missing (no PAPER_EXCHANGE_API_KEY,
 *     FLEET_IN_DEV=off): dev still starts normally and the cockpit log says why;
 *   - NEVER sends Telegram alerts or any other notification: it imports nothing from src/ops,
 *     emits only 'state' and 'log' events for the local TUI. The main agent's alerting pipeline
 *     is untouched — fleet decisions are research evidence, not operator interruptions.
 *
 * Entries follow the same rule as the standalone fleet: OFF (shadow, R1) unless the operator
 * explicitly exports MINICPM_ENTRIES=on.
 */

export const FLEET_SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;
const ANCHOR = 'BTCUSDT';
const ALL_SYMBOLS = [ANCHOR, ...FLEET_SYMBOLS] as const;
const EVAL_INTERVAL_MS = 10_000;
const STATE_EMIT_INTERVAL_MS = 250;

export interface FleetSupervisorOptions {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.argv (supports the same --model/--route/--host/--timeout-ms flags as npm run fleet). */
  argv?: readonly string[];
  /** Test override for the fleet-wide model spec. */
  model?: string;
  /** Test override for the per-symbol route spec. */
  route?: string;
  /** Test override for the LLM host. */
  host?: string;
}

export interface FleetState {
  /** False when the embedded fleet is parked (no token, opted out, or boot refusal). */
  enabled: boolean;
  /** Human-readable reason whenever enabled is false. */
  disabledReason?: string;
  entriesEnabled: boolean;
  llmHost: string;
  startedAt: number;
  /** 'ETHUSDT' -> resolved Ollama tag driving that worker's decisions. */
  assignment: Record<string, string>;
  bySymbol: Record<string, WorkerStatus>;
}

interface FleetConfig {
  entriesEnabled: boolean;
  llmHost: string;
  timeoutMs: number;
  assignment: Record<string, string>;
  paperExchange: { url: string; apiKey: string };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** The binance package's typed event map omits 'message'/'error'; this is the minimal surface the supervisor uses. */
interface FleetWebSocket {
  on(event: string, handler: (data: unknown) => void): void;
  subscribeTrades(symbol: string, market: string): void;
  closeAll(): void;
}

export class FleetSupervisor extends EventEmitter {
  private readonly env: NodeJS.ProcessEnv;
  private workers = new Map<string, SymbolTraderWorker>();
  private futuresClient: USDMClient | null = null;
  private marketData: MarketDataService | null = null;
  private marketStateBuilder = new MarketStateBuilder();
  private ws: FleetWebSocket | null = null;
  private evalTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private running = false;
  private stopped = false;
  private lastEmit = 0;
  private latest: FleetState | null = null;

  constructor(private readonly options: FleetSupervisorOptions = {}) {
    super();
    this.env = options.env ?? process.env;
  }

  private log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emit('log', { msg: `[fleet] ${msg}`, level });
  }

  /** Resolves the embedded configuration or a disabled reason; never throws. */
  private resolveConfig(): { config?: FleetConfig; disabledReason?: string } {
    if ((this.env.FLEET_IN_DEV ?? '').trim().toLowerCase() === 'off') {
      return { disabledReason: 'FLEET_IN_DEV=off — embedded fleet opted out' };
    }

    let paperExchange;
    try {
      paperExchange = resolveFleetPaperExchange(this.env);
    } catch (err) {
      return { disabledReason: `parked: ${(err as Error).message}` };
    }

    const argv = this.options.argv ?? process.argv;
    const modelSpec = this.options.model ?? argValue(argv, '--model') ?? this.env.FLEET_MODEL ?? DEFAULT_FLEET_MODEL_ID;
    const routeSpec = this.options.route ?? argValue(argv, '--route') ?? this.env.FLEET_MODEL_ROUTE;
    const llmHost = this.options.host ?? argValue(argv, '--host') ?? this.env.FLEET_LLM_HOST ?? DEFAULT_LLM_HOST;
    const timeoutMs =
      Number.parseInt(argValue(argv, '--timeout-ms') ?? this.env.FLEET_LLM_TIMEOUT_MS ?? '', 10) || DEFAULT_LLM_TIMEOUT_MS;

    try {
      const assignment = resolveFleetModelAssignment({
        symbols: FLEET_SYMBOLS,
        defaultSpec: modelSpec,
        ...(routeSpec ? { route: parseModelRoute(routeSpec) } : {}),
      });
      return {
        config: {
          entriesEnabled: this.env.MINICPM_ENTRIES === 'on' || argv.includes('--enable-entries'),
          llmHost,
          timeoutMs,
          assignment: assignment.bySymbol,
          paperExchange,
        },
      };
    } catch (err) {
      return { disabledReason: `model selection refused: ${(err as Error).message}` };
    }
  }

  private emitState(enabled: boolean, disabledReason?: string): void {
    const bySymbol: Record<string, WorkerStatus> = {};
    for (const [symbol, worker] of this.workers) bySymbol[symbol] = worker.getStatus();

    const resolved = this.resolveConfig();
    const fleetConfig = resolved.config;
    const state: FleetState = {
      enabled,
      ...(disabledReason ? { disabledReason } : {}),
      entriesEnabled: fleetConfig?.entriesEnabled ?? false,
      llmHost: fleetConfig?.llmHost ?? DEFAULT_LLM_HOST,
      startedAt: this.startedAt || Date.now(),
      assignment: fleetConfig?.assignment ?? {},
      bySymbol,
    };
    this.latest = state;
    this.emit('state', state);
  }

  private throttledEmit(): void {
    const now = Date.now();
    if (now - this.lastEmit < STATE_EMIT_INTERVAL_MS) return;
    this.lastEmit = now;
    this.emitState(true);
  }

  async start(): Promise<void> {
    if (this.running || this.stopped) return;
    const resolved = this.resolveConfig();
    if (!resolved.config) {
      this.log(resolved.disabledReason ?? 'parked', 'warn');
      this.emitState(false, resolved.disabledReason);
      return;
    }
    const fleetConfig = resolved.config;
    this.running = true;
    this.startedAt = Date.now();

    const models = [...new Set(Object.values(fleetConfig.assignment))];
    const notes = models.map((tag) => `${tag}${lookupModelByTag(tag) ? '' : ' (not in shortlist)'}`).join(', ');
    this.log(`embedded multi-model fleet online — models: ${notes}; entries ${fleetConfig.entriesEnabled ? 'ARMED (risk-gated)' : 'OFF (shadow, R1)'}`);

    this.futuresClient = new USDMClient({
      api_key: config.binance.apiKey,
      api_secret: config.binance.apiSecret,
    });
    this.marketData = new MarketDataService(this.futuresClient, DEFAULT_MARKET_DATA_OPTIONS);

    for (const symbol of FLEET_SYMBOLS) {
      const symKey = symbol.replace('USDT', '').toLowerCase();
      const modelTag = fleetConfig.assignment[symbol];
      const llm = new MiniCpmService({ host: fleetConfig.llmHost, model: modelTag, timeoutMs: fleetConfig.timeoutMs });
      const worker = new SymbolTraderWorker(
        {
          symbol,
          accountId: `crypto-minicpm-${symKey}`,
          paperExchangeUrl: fleetConfig.paperExchange.url,
          apiKey: fleetConfig.paperExchange.apiKey,
          marginPerPosition: 1000,
          leverage: 10,
          entriesEnabled: fleetConfig.entriesEnabled,
          modelTag,
        },
        llm,
      );
      // The embedded fleet must never break dev startup: a downed paper exchange parks the
      // worker's account sync (same as the standalone runner) instead of throwing.
      try {
        await worker.syncAccount();
      } catch {
        this.log(`${symbol}: paper exchange unreachable at boot; worker continues without account sync`, 'warn');
      }
      this.workers.set(symbol, worker);
    }

    const silent = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
    const ws = new WebsocketClient({ beautify: false }, silent as never) as unknown as FleetWebSocket;
    this.ws = ws;
    ws.on('error', (err) => this.log(`Binance WS error: ${(err as { message?: string })?.message ?? 'unknown'}`, 'warn'));
    ws.on('message', (raw) => {
      const data = raw as { e?: string; s?: string; p?: string };
      if (data?.e === 'trade' && data.s && Number(data.p) > 0) {
        const worker = this.workers.get(data.s);
        if (worker) {
          void worker.onLiveTick(Number(data.p)).then(() => this.throttledEmit());
        }
      }
    });
    for (const sym of ALL_SYMBOLS) ws.subscribeTrades(sym, 'usdm');

    this.emitState(true);

    this.evalTimer = setInterval(() => void this.runEvaluationCycle(), EVAL_INTERVAL_MS);
    this.stateTimer = setInterval(() => this.emitState(true), 2000);
    void this.runEvaluationCycle();
  }

  private async runEvaluationCycle(): Promise<void> {
    if (!this.running || !this.marketData) return;
    try {
      const snapshots = await this.marketData.snapshot(ALL_SYMBOLS as unknown as string[]);
      const btcSnapshot = snapshots[ANCHOR];
      const btc15m = btcSnapshot?.candles['15m'] ?? [];
      const btc1h = btcSnapshot?.candles['1h'] ?? [];

      for (const symbol of FLEET_SYMBOLS) {
        const snap = snapshots[symbol];
        if (!snap) continue;
        const sym15m = snap.candles['15m'] ?? [];
        const sym1h = snap.candles['1h'] ?? [];
        const sym4h = snap.candles['4h'] ?? [];
        const markPrice = sym15m.at(-1)?.close;
        const worker = this.workers.get(symbol);
        if (!markPrice || !worker || btc15m.length === 0) continue;

        const marketState = sym15m.length >= 50
          ? this.marketStateBuilder.build({
              symbol,
              candles: sym15m,
              candlesByTimeframe: { '15m': sym15m, '1h': sym1h, '4h': sym4h },
              mark: markPrice,
              fundingRate: 0,
              derivatives: snap.derivatives ?? null,
            })
          : undefined;

        await worker.evaluate({
          markPrice,
          btcCandles15m: btc15m,
          btcCandles1h: btc1h,
          symbolCandles15m: sym15m,
          symbolCandles1h: sym1h,
          marketState,
        });
      }
      this.throttledEmit();
    } catch (err) {
      this.log(`evaluation cycle error: ${(err as Error).message}`, 'error');
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    try {
      this.ws?.closeAll();
    } catch {
      // a WS that is already dead must not break dev shutdown
    }
    this.log('embedded fleet stopped');
  }

  /** Latest emitted state (or a freshly derived disabled snapshot before start). */
  get state(): FleetState {
    if (this.latest) return this.latest;
    const resolved = this.resolveConfig();
    return {
      enabled: false,
      disabledReason: resolved.disabledReason ?? 'not started',
      entriesEnabled: resolved.config?.entriesEnabled ?? false,
      llmHost: resolved.config?.llmHost ?? DEFAULT_LLM_HOST,
      startedAt: 0,
      assignment: resolved.config?.assignment ?? {},
      bySymbol: {},
    };
  }
}
