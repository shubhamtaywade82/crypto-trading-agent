import { Ollama } from 'ollama';
import { config } from '../config.js';
import type { Position, LogEntry, VetoSnapshot } from '../types.js';

export interface VetoVerdict {
  verdict: 'PROCEED' | 'VETO';
  reason: string;
}

const VETO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 60_000;

/** Parses the model's JSON reply; anything unusable proceeds, because deterministic code owns the entry. */
export function parseVerdict(text: string): VetoVerdict {
  try {
    const parsed = JSON.parse(text);
    const reason = String(parsed.reason ?? '');
    if (parsed.verdict === 'VETO') return { verdict: 'VETO', reason };
    if (parsed.verdict === 'PROCEED') return { verdict: 'PROCEED', reason };
    return { verdict: 'PROCEED', reason: `advisor sent an unknown verdict "${parsed.verdict}"` };
  } catch {
    return { verdict: 'PROCEED', reason: 'advisor sent an unparseable reply' };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * LLM layer via Ollama.
 * advise/ask enrich logs only. veto() may block an entry the deterministic agents proposed,
 * but can never originate one; when Ollama is offline, slow or malformed, the entry proceeds.
 */
export class OllamaAdvisor {
  private available = false;
  private lastPingAt = 0;

  constructor(private client: Pick<Ollama, 'list' | 'generate'> = new Ollama({ host: config.ollama.host })) {
    this.ping();
  }

  get isOnline(): boolean {
    return this.available;
  }

  private async ping(): Promise<void> {
    this.lastPingAt = Date.now();
    try {
      await withTimeout(this.client.list(), VETO_TIMEOUT_MS);
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  async veto(snapshot: VetoSnapshot): Promise<VetoVerdict> {
    // Ollama often starts after the bot; without a re-ping the veto stays disabled until restart.
    if (!this.available && Date.now() - this.lastPingAt >= PING_INTERVAL_MS) await this.ping();
    if (!this.available) return { verdict: 'PROCEED', reason: 'advisor offline' };
    const prompt = `You review a proposed crypto futures entry. Snapshot: ${JSON.stringify(snapshot)}. ` +
      'Reply with JSON only: {"verdict":"PROCEED"|"VETO","reason":"<max 15 words>"}. ' +
      'VETO only for a concrete reason such as an overextended entry or crowded funding.';
    try {
      const res = await withTimeout(
        this.client.generate({ model: config.ollama.model, prompt, format: 'json', stream: false }),
        VETO_TIMEOUT_MS,
      );
      return parseVerdict(res.response);
    } catch (err) {
      return { verdict: 'PROCEED', reason: `advisor error: ${(err as Error).message}` };
    }
  }

  async advise(positions: Position[], signals: string[]): Promise<LogEntry | null> {
    if (!this.available) return null;
    try {
      const prompt = `You are a crypto futures risk analyst. Portfolio: ${JSON.stringify(positions.slice(0, 3))}. Recent signals: ${signals.slice(-5).join('; ')}. Provide ONE sentence risk assessment, max 20 words.`;
      const res = await this.client.generate({
        model: config.ollama.model,
        prompt,
        stream: false,
      });
      return {
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: `OLLAMA-ADVISOR: ${res.response.trim().slice(0, 120)}`,
        level: 'info',
      };
    } catch {
      return null;
    }
  }

  async ask(question: string, context?: { positions: Position[]; equity: number }): Promise<LogEntry> {
    if (!this.available) {
      return this.localAssessment(question, context);
    }
    try {
      const portfolioBrief = context
        ? `Equity: $${context.equity.toFixed(2)}, Positions: ${context.positions.length}`
        : 'Portfolio: active';
      const prompt = `You are an institutional crypto risk advisor. Context: ${portfolioBrief}. Question: ${question}. Answer concisely in at most 25 words.`;
      const res = await this.client.generate({
        model: config.ollama.model,
        prompt,
        stream: false,
      });
      return {
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: `ADVISOR-AUDIT: ${res.response.trim().slice(0, 120)}`,
        level: 'info',
      };
    } catch {
      return this.localAssessment(question, context);
    }
  }

  private localAssessment(question: string, context?: { positions: Position[]; equity: number }): LogEntry {
    const posCount = context?.positions.length ?? 0;
    const upnl = context?.positions.reduce((sum, p) => sum + p.upnl, 0) ?? 0;
    return {
      ts: Date.now(),
      agent: 'SYSTEM',
      msg: `LOCAL-AUDIT: [${question}] ${posCount} pos open, net uPnL $${upnl.toFixed(1)}. Margin safe, SLs active.`,
      level: 'info',
    };
  }
}
