import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { jsonFormatFor } from '../ollama/jsonMode.js';
import { DEFAULT_FLEET_MODEL_TAG, DEFAULT_LLM_HOST } from './FleetModels.js';
import { buildTradingPrompt, type LlmTradeRecommendation, type PromptInput } from './FleetPrompt.js';

export interface OllamaClientOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
  /** Bearer token for a cloud host; the SDK falls back to OLLAMA_API_KEY when unset. */
  apiKey?: string;
  /** Several cloud keys: calls rotate across them and fail over to the next key on error. Wins over apiKey. */
  apiKeys?: readonly string[];
}

/**
 * Ollama-backed trade-decision advisor for the fleet worker. Model-agnostic: any Ollama tag works
 * (src/fleet/FleetModels.ts lists the cloud registry). The prompt and the JSON validation contract are
 * identical for every model, so model comparisons are apples-to-apples by construction.
 */
export class FleetLlmService {
  private readonly host: string;
  private readonly model: string;
  private readonly clients: OllamaClient[];
  private keyIndex = 0;

  constructor(options: OllamaClientOptions = {}) {
    this.host = options.host ?? DEFAULT_LLM_HOST;
    this.model = options.model ?? DEFAULT_FLEET_MODEL_TAG;
    // One attempt per key, each bounded by timeoutMs: when every key fails the worker treats the tick as no-signal.
    const timeoutMs = options.timeoutMs ?? 30_000;
    const keys: (string | undefined)[] = options.apiKeys?.length ? [...options.apiKeys] : [options.apiKey];
    this.clients = keys.map((apiKey) => new OllamaClient({ baseUrl: this.host, timeoutMs, retries: 0, apiKey }));
  }

  // Round-robin spreads free-tier rate limits across every key; a failing key hands the call to the next one.
  private async generate(prompt: string): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      const idx = (this.keyIndex + attempt) % this.clients.length;
      try {
        const text = await this.clients[idx].generateText({
          model: this.model,
          prompt,
          ...jsonFormatFor(this.host),
          options: { temperature: 0, top_p: 0.9 },
        });
        this.keyIndex = (idx + 1) % this.clients.length;
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async analyze(input: PromptInput): Promise<LlmTradeRecommendation | null> {
    const prompt = buildTradingPrompt(input);
    try {
      const rawText = await this.generate(prompt);
      return this.parseAndValidate(rawText.trim());
    } catch (err) {
      console.error(`[fleet-llm] Error evaluating ${input.symbol}:`, (err as Error).message);
      return null;
    }
  }

  private parseAndValidate(raw: string): LlmTradeRecommendation | null {
    try {
      const cleanJson = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const parsed = JSON.parse(cleanJson);

      const action = parsed.action?.toUpperCase();
      if (action !== 'ENTER_LONG' && action !== 'ENTER_SHORT' && action !== 'HOLD') {
        return null;
      }

      return {
        action,
        confidence: Number(parsed.confidence) || (action === 'HOLD' ? 0.5 : 0.7),
        reason: String(parsed.reason || (action === 'HOLD' ? 'Hold signal' : 'AI setup verified')),
      };
    } catch {
      return null;
    }
  }
}
