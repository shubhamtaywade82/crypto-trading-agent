import { Ollama } from 'ollama';
import { config } from '../config.js';
import type { Position, LogEntry } from '../types.js';

/**
 * LLM advisory layer via Ollama.
 * Non-blocking: enriches logs with narrative context.
 * NEVER makes trading decisions — deterministic agents own execution.
 */
export class OllamaAdvisor {
  private client: Ollama;
  private available = false;

  constructor() {
    this.client = new Ollama({ host: config.ollama.host });
    this.ping();
  }

  get isOnline(): boolean {
    return this.available;
  }

  private async ping(): Promise<void> {
    try {
      await this.client.list();
      this.available = true;
    } catch {
      this.available = false;
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
