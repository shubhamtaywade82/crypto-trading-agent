import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { jsonFormatFor } from '../ollama/jsonMode.js';
import { buildTradingPrompt, type LlmTradeRecommendation, type PromptInput } from './MiniCpmPrompt.js';

export interface OllamaClientOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
  /** Bearer token for a cloud host; the SDK falls back to OLLAMA_API_KEY when unset. */
  apiKey?: string;
}

export class MiniCpmService {
  private readonly host: string;
  private readonly model: string;
  private readonly client: OllamaClient;

  constructor(options: OllamaClientOptions = {}) {
    this.host = options.host ?? 'http://127.0.0.1:11434';
    this.model = options.model ?? 'openbmb/minicpm5-2b:latest';
    // One attempt bounded by timeoutMs: a failed call returns null and the worker treats the tick as no-signal.
    this.client = new OllamaClient({ baseUrl: this.host, timeoutMs: options.timeoutMs ?? 30_000, retries: 0, apiKey: options.apiKey });
  }

  async analyze(input: PromptInput): Promise<LlmTradeRecommendation | null> {
    const prompt = buildTradingPrompt(input);
    try {
      const rawText = await this.client.generateText({
        model: this.model,
        prompt,
        ...jsonFormatFor(this.host),
        options: { temperature: 0.2, top_p: 0.9 },
      });
      return this.parseAndValidate(rawText.trim(), input.symbolContext.price);
    } catch (err) {
      console.error(`[MiniCPM] Error evaluating ${input.symbol}:`, (err as Error).message);
      return null;
    }
  }

  private parseAndValidate(raw: string, currentPrice: number): LlmTradeRecommendation | null {
    try {
      const cleanJson = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const parsed = JSON.parse(cleanJson);

      const action = parsed.action?.toUpperCase();
      if (action !== 'ENTER_LONG' && action !== 'ENTER_SHORT' && action !== 'HOLD') {
        return null;
      }

      if (action === 'HOLD') {
        return {
          action: 'HOLD',
          confidence: Number(parsed.confidence) || 0.5,
          entry: currentPrice,
          stopLoss: currentPrice,
          takeProfit: currentPrice,
          reason: parsed.reason ?? 'Hold signal',
        };
      }

      const entry = Number(parsed.entry) || currentPrice;
      const stopLoss = Number(parsed.stopLoss);
      const takeProfit = Number(parsed.takeProfit);
      const confidence = Number(parsed.confidence) || 0.7;

      if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
        return null;
      }

      // Check min 0.5% profit requirement for 5% return at 10x
      if (action === 'ENTER_LONG') {
        if (stopLoss >= entry || takeProfit <= entry) return null;
        const profitMovePct = ((takeProfit - entry) / entry) * 100;
        if (profitMovePct < 0.49) return null; // allow small rounding
      } else if (action === 'ENTER_SHORT') {
        if (stopLoss <= entry || takeProfit >= entry) return null;
        const profitMovePct = ((entry - takeProfit) / entry) * 100;
        if (profitMovePct < 0.49) return null;
      }

      return {
        action,
        confidence,
        entry,
        stopLoss,
        takeProfit,
        reason: String(parsed.reason || 'AI setup verified'),
      };
    } catch {
      return null;
    }
  }
}
