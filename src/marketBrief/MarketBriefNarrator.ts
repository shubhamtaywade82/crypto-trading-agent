import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { config } from '../config.js';
import { briefNarrativeSchema } from './schemas.js';
import type { MarketBrief } from './types.js';
import { z } from 'zod';

export type BriefNarrative = z.infer<typeof briefNarrativeSchema>;

export interface NarratorClient {
  generateText(request: { model: string; prompt: string; format?: 'json'; timeoutMs?: number }): Promise<string>;
}

// Builds constrained evidence prompt: LLM explains deterministic facts, cannot alter decision
function buildNarrativePrompt(brief: MarketBrief): string {
  const { symbol, market, timeframes, derivatives, decision, levels } = brief;

  return [
    `You are an expert crypto market analyst writing an internal briefing.`,
    `DETERMINISTIC FACTS (DO NOT INVENT NUMBERS OR CHANGE DECISION):`,
    `Symbol: ${symbol}`,
    `Price: $${market.lastPrice ?? 'N/A'} (24h: ${market.change24hPct ?? 0}%)`,
    `Structure: 5m=${timeframes['5m'].bias}, 15m=${timeframes['15m'].bias}, 1h=${timeframes['1h'].bias}, 4h=${timeframes['4h'].bias}`,
    `Funding: ${derivatives.fundingRate ?? 0}, OI Change: ${derivatives.openInterestChangePct ?? 0}%`,
    `Deterministic Decision: ${decision.action} (${decision.bias} bias)`,
    `Refusal Reasons: ${decision.reasonCodes.join(', ')}`,
    `Support Level: ${levels.support ? `$${levels.support[0]}-$${levels.support[1]}` : 'none'}`,
    `Resistance Level: ${levels.resistance ? `$${levels.resistance[0]}-$${levels.resistance[1]}` : 'none'}`,
    ``,
    `Provide a JSON explanation strictly following this schema:`,
    `{"summary": "...", "bullishConditions": ["..."], "bearishConditions": ["..."], "unresolvedConflicts": ["..."], "dataLimitations": ["..."]}`,
  ].join('\n');
}

export class MarketBriefNarrator {
  private readonly client: NarratorClient | null;
  private readonly model: string;

  constructor(client?: NarratorClient | null, model?: string) {
    this.model = model ?? config.ollama.model;
    if (client !== undefined) {
      this.client = client;
    } else {
      this.client = Boolean(config.ollama.host)
        ? (new OllamaClient({ baseUrl: config.ollama.host, timeoutMs: 15_000 }) as unknown as NarratorClient)
        : null;
    }
  }

  // Generates structured narrative explanation; falls back safely to null on any failure
  async narrateBrief(brief: MarketBrief): Promise<BriefNarrative | null> {
    if (!this.client) return null;

    try {
      const prompt = buildNarrativePrompt(brief);
      const raw = await this.client.generateText({
        model: this.model,
        prompt,
        format: 'json',
        timeoutMs: 10_000,
      });

      const parsed = JSON.parse(raw);
      return briefNarrativeSchema.parse(parsed);
    } catch {
      // Deterministic fallback: failure of the narrative LLM must never drop or alter the brief
      return null;
    }
  }
}
