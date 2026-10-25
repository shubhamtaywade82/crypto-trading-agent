import { BinanceClient } from '@nemesis-oss/binance-sdk';
import type { OptionsConfig } from './config.js';
import { OptionChainService, sdkOptionsSource } from './OptionChainService.js';
import { OptionsBuyingEngine, type HaltSwitch, type LogLevel, type OptionVetoer, type UnderlyingStatus } from './OptionsBuyingEngine.js';
import { OptionsJournal, OptionsStateStore } from './stateStore.js';
import { SdkUnderlyingContextSource, sdkKlineReader } from './UnderlyingContext.js';
import { LocalOptionsPaperVenue, MonitorOnlyVenue, PaperExchangeOptionsVenue, type OptionsVenue } from './venues.js';

/** What the cockpit shows for the options book. */
export interface OptionsDeskView {
  venue: string;
  executing: boolean;
  state: 'starting' | 'running' | 'down';
  equity: number | null;
  halt: string | null;
  lastError: string | null;
  rows: UnderlyingStatus[];
}

export interface OptionsDeskDeps {
  config: OptionsConfig;
  killSwitch: HaltSwitch;
  vetoer: OptionVetoer | null;
  log: (level: LogLevel, message: string) => void;
  /** Builds the engine and its venue; overridden in tests. The default reads Binance through a read-only binance-sdk client. */
  build?: (config: OptionsConfig, deps: Pick<OptionsDeskDeps, 'killSwitch' | 'vetoer' | 'log'>) => Promise<{ engine: OptionsBuyingEngine; venue: OptionsVenue }>;
}

async function defaultBuild(cfg: OptionsConfig, deps: Pick<OptionsDeskDeps, 'killSwitch' | 'vetoer' | 'log'>): Promise<{ engine: OptionsBuyingEngine; venue: OptionsVenue }> {
  const client = new BinanceClient({ safety: { readOnly: true } });
  await client.syncTime();
  const refused = new Set<string>();
  const chain = new OptionChainService(sdkOptionsSource(client), {
    onRejectedContract: (symbol, reason) => {
      if (refused.has(symbol)) return;
      refused.add(symbol);
      deps.log('warn', `contract ${symbol} ignored: ${reason}`);
    },
  });
  let venue: OptionsVenue;
  switch (cfg.venue) {
    case 'local':
      venue = new LocalOptionsPaperVenue(cfg.localEquity, cfg.fees);
      break;
    case 'paper_exchange': {
      const pe = cfg.paperExchange!;
      const remote = new PaperExchangeOptionsVenue(pe.url, pe.accountId, cfg.fees, { apiKey: pe.apiKey });
      await remote.ensureAccount(cfg.localEquity);
      venue = remote;
      break;
    }
    case 'monitor':
      venue = new MonitorOnlyVenue('options-monitor', cfg.localEquity);
      break;
  }
  const engine = new OptionsBuyingEngine({
    config: cfg,
    chain,
    context: new SdkUnderlyingContextSource(sdkKlineReader(client)),
    venue,
    vetoer: deps.vetoer,
    killSwitch: deps.killSwitch,
    store: new OptionsStateStore(cfg.statePath),
    journal: new OptionsJournal(cfg.journalPath),
    log: deps.log,
  });
  return { engine, venue };
}

/**
 * The options book inside the cockpit: one engine on its own cadence beside the futures loop. Options run in their own
 * wallet (the local book, or a separate paper_exchange account), like Binance's Options wallet. The kill switch and the
 * Ollama advisor are shared with futures. A failed start (Binance unreachable, paper_exchange down) is retried each
 * tick; nothing here can throw into the futures loop.
 */
export class OptionsDesk {
  private engine: OptionsBuyingEngine | null = null;
  private venue: OptionsVenue | null = null;
  private equity: number | null = null;
  private lastError: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly deps: OptionsDeskDeps) {}

  get loopMs(): number {
    return this.deps.config.loopMs;
  }

  /** Starts the engine if it is not running yet, otherwise runs one cycle. Never throws. */
  async tick(): Promise<void> {
    try {
      if (!this.engine) {
        await this.start();
        if (!this.engine) return;
      }
      await this.engine.cycle();
      this.equity = await this.venue!.equity().catch(() => this.equity);
      this.lastError = null;
    } catch (err) {
      this.fail(err);
    }
  }

  view(): OptionsDeskView {
    const cfg = this.deps.config;
    return {
      venue: this.venue?.name ?? cfg.venue,
      executing: this.venue ? this.venue.canExecute : cfg.venue !== 'monitor',
      state: this.engine ? 'running' : this.lastError ? 'down' : 'starting',
      equity: this.equity,
      halt: this.engine?.riskHalt() ?? null,
      lastError: this.lastError,
      rows: this.engine?.status() ?? cfg.underlyings.map((underlying) => ({ underlying, state: 'IDLE' as const, note: this.lastError ?? 'starting', position: null })),
    };
  }

  private async start(): Promise<void> {
    this.starting ??= (async () => {
      const build = this.deps.build ?? defaultBuild;
      const { engine, venue } = await build(this.deps.config, this.deps);
      await engine.start();
      this.engine = engine;
      this.venue = venue;
      this.equity = await venue.equity().catch(() => null);
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  private fail(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    if (text !== this.lastError) this.deps.log('error', `${this.engine ? 'cycle failed' : 'start failed, retrying next tick'}: ${text}`);
    this.lastError = text;
  }
}
