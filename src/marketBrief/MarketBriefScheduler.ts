import { MarketBriefService } from './MarketBriefService.js';
import { diffMarketBriefs } from './MarketBriefDiff.js';
import { formatMarketBriefCard } from './MarketBriefFormatter.js';
import { appendBriefToJournal, readLatestBriefFromJournal } from './MarketBriefJournal.js';
import { sendTelegram } from '../ops/telegram.js';
import type { MarketBrief } from './types.js';

export interface SchedulerOptions {
  readonly symbols: readonly string[];
  readonly intervalMs: number; // e.g. 5m (300_000)
  readonly alertOnChange: boolean;
  readonly journalDir?: string;
  readonly onBriefEmitted?: (brief: MarketBrief, card: string) => void;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  symbols: ['SOLUSDT'],
  intervalMs: 5 * 60_000,
  alertOnChange: true,
};

export class MarketBriefScheduler {
  private readonly service: MarketBriefService;
  private readonly options: SchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private isTickRunning = false;
  private isRunning = false;

  constructor(service?: MarketBriefService, options: Partial<SchedulerOptions> = {}) {
    this.service = service ?? new MarketBriefService();
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
  }

  // Executes a single analysis pass per configured symbol without overlapping
  async tick(now: number = Date.now()): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;

    try {
      for (const symbol of this.options.symbols) {
        await this.processSymbol(symbol, now);
      }
    } finally {
      this.isTickRunning = false;
    }
  }

  private async processSymbol(symbol: string, now: number): Promise<void> {
    try {
      const brief = await this.service.generateBrief(symbol, now);
      const prev = readLatestBriefFromJournal(symbol, this.options.journalDir);
      const diff = diffMarketBriefs(brief, prev);

      appendBriefToJournal(brief, this.options.journalDir);

      const card = formatMarketBriefCard(brief);
      if (this.options.onBriefEmitted) {
        this.options.onBriefEmitted(brief, card);
      }

      const shouldBroadcast = !prev || diff.isMaterialChange || this.options.alertOnChange;
      if (shouldBroadcast) {
        const channel = brief.decision.action === 'NO_TRADE' ? 'alert' : 'trading';
        await sendTelegram(card, { channel });
      }
    } catch (err) {
      console.error(`[MARKET_BRIEF ERROR] ${symbol}: ${(err as Error).message}`);
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    void this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
