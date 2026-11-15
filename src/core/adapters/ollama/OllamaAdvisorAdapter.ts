import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';
import { jsonFormatFor, parseJsonLoose } from '../../../ollama/jsonMode.js';
import type { AdvisorBrief, AdvisorOpinion, DecisionAdvisorPort } from '../../ports/DecisionAdvisorPort.js';

/** The one SDK call the advisor makes, narrowed so tests never open a socket. */
export interface AdvisorTextClient {
  generateText(request: { model: string; prompt: string; format?: 'json'; timeoutMs?: number }): Promise<string>;
}

export interface OllamaAdvisorOptions {
  readonly host: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly apiKey?: string;
}

const Reply = z.object({ verdict: z.enum(['PROCEED', 'VETO']), reason: z.string().max(400) });

export const ollamaTextClient = (options: OllamaAdvisorOptions): AdvisorTextClient =>
  new OllamaClient({ baseUrl: options.host, timeoutMs: options.timeoutMs, retries: 0, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Structured second opinion from an Ollama model.
 *
 * - No answer (offline, timeout, transport error): UNAVAILABLE. The deterministic pipeline decides alone.
 * - An answer that is not the requested JSON shape: VETO. A model that replies but cannot follow the contract is a
 *   fault an operator should look at, not a reason to wave an entry through.
 * The reply is validated against a schema with two fields. There is no field through which a model could set a
 * price, a size or a limit.
 */
export class OllamaAdvisorAdapter implements DecisionAdvisorPort {
  constructor(private readonly client: AdvisorTextClient, private readonly options: OllamaAdvisorOptions) {}

  async review(brief: AdvisorBrief): Promise<AdvisorOpinion> {
    const { model, timeoutMs, host } = this.options;
    const prompt = `You review a proposed crypto perpetual futures entry on a paper account. Proposal: ${JSON.stringify(brief)}. ` +
      'Reply with JSON only: {"verdict":"PROCEED"|"VETO","reason":"<max 20 words>"}. ' +
      'VETO only for a concrete reason visible in the proposal, such as crowded funding against the trade or a reward:risk that does not justify it.';
    let text: string;
    try {
      text = await withTimeout(this.client.generateText({ model, prompt, timeoutMs, ...jsonFormatFor(host) }), timeoutMs);
    } catch (error) {
      return { verdict: 'UNAVAILABLE', reason: `advisor unreachable: ${error instanceof Error ? error.message : String(error)}`, model };
    }
    try {
      const reply = Reply.parse(parseJsonLoose(text));
      return { verdict: reply.verdict, reason: reply.reason, model };
    } catch {
      return { verdict: 'VETO', reason: 'advisor sent a reply that does not match the contract', model };
    }
  }
}
