/**
 * Agentic proposal stage (opt-in: `research:run --propose N`). An Ollama model drafts new hypothesis specs; each draft must
 * pass the same schema and evaluator limits as a hand-written spec, and rejected drafts are fed back once for repair.
 *
 * Guardrails: status is forced to DRAFT and endIso is stripped, so a proposal can neither read a test window nor touch the
 * OOS ledger. Promoting one to REGISTERED is a human edit. The prompt carries no evaluation output (only the ids and
 * hypotheses already on disk, to avoid duplicates), so the model cannot tune against results.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseJsonLoose } from '../../ollama/jsonMode.js';
import { readParams } from './evaluate.js';
import { parseSpec, type HypothesisSpec } from './hypothesis.js';

export const PROPOSAL_ID_PREFIX = 'LLM-';
/** Symbols the archive and the context taxonomy cover; a hallucinated symbol would fail the whole run's data stage. */
const RESEARCH_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
/**
 * Floors a proposal cannot go below. Prompt text alone is not a guard: a draft that lowers the bar would look like evidence later.
 * Cost: Binance USDⓈ-M taker is ~5 bps a side before slippage. Trades: the registry evidence policy minimum. Window: a year
 * leaves the 1h/4h train segment past the 200-bar warmup.
 */
const PROPOSAL_FLOORS = { minRoundTripBps: 10, minOosTrades: 100, maxAlpha: 0.05, minDays: 365, maxDays: 1460 };
const MAX_ATTEMPTS = 2;
/** A cloud reasoning model took ~18s for two specs in testing; leave room for slow hours. */
const LLM_TIMEOUT_MS = 180_000;

export interface LlmClient {
  generateText(request: { model: string; prompt: string; timeoutMs?: number }): Promise<string>;
}

export interface ProposeArgs {
  client: LlmClient;
  model: string;
  count: number;
  /** Specs already on disk: their ids block duplicates and their hypotheses are shown to the model. */
  existing: HypothesisSpec[];
  /** Progress lines for the operator; silent when omitted. */
  log?: (line: string) => void;
}

export interface ProposalAttempt {
  attempt: number;
  prompt: string;
  /** Raw model reply, kept so every proposal can be audited against exactly what the model said. */
  reply: string;
  latencyMs: number;
  accepted: string[];
  rejected: string[];
}

export interface ProposeResult {
  proposals: HypothesisSpec[];
  /** Why drafts were dropped across all attempts (schema, evaluator limits, duplicates, unreadable reply). */
  rejected: string[];
  attempts: ProposalAttempt[];
}

function buildPrompt(args: ProposeArgs, wanted: number, repairs: string[]): string {
  const known = args.existing.map((s) => `- ${s.id}@${s.version}: ${s.hypothesis}`).join('\n') || '(none)';
  const repairBlock = repairs.length ? `\nYour previous drafts were rejected. Fix these problems:\n${repairs.map((r) => `- ${r}`).join('\n')}\n` : '';
  return `You propose hypothesis specs for an automated crypto-futures research pipeline. Reply with JSON only: {"proposals":[<spec>, ...]} holding exactly ${wanted} spec(s).
Each spec has exactly these keys: schemaVersion (1), id, version (1), status ("DRAFT"), hypothesis, family, symbols, timeframes, timeframeRule, context {id, taxonomyVersion}, params, window {days, endDaysAgo (0), split {trainPct, validationPct, testPct}}, costs {roundTripBps}, evidence {minOosTrades, alpha}.
Hard limits (the evaluator rejects anything else): family "DONCHIAN_BREAKOUT"; context {"id":"EMA50_GT_EMA200_ATR14_Q33_TRAIN","taxonomyVersion":"ctx-v1"}; params exactly lookback (integer), stopAtr, targetR, maxHoldingBars (integer), all positive; symbols only from ${RESEARCH_SYMBOLS.join(' ')}; timeframes only from 4h 1h 15m; window.days between ${PROPOSAL_FLOORS.minDays} and ${PROPOSAL_FLOORS.maxDays}; split percentages sum to 100; costs.roundTripBps at least ${PROPOSAL_FLOORS.minRoundTripBps}; evidence.minOosTrades at least ${PROPOSAL_FLOORS.minOosTrades} and alpha at most ${PROPOSAL_FLOORS.maxAlpha}; id of uppercase letters, digits, "_" or "-", starting with "${PROPOSAL_ID_PREFIX}".
The hypothesis must state the market mechanism that would make the edge real, written before any result exists, not a parameter-tuning rationale.
Specs already on disk (do not duplicate their ids or ideas):
${known}${repairBlock}`;
}

/** Forces the policy fields, then applies the schema and the evaluator's own limits. Throws with the reason on any failure. */
function checkDraft(raw: unknown, taken: Set<string>): HypothesisSpec {
  const draft = { ...(raw as Record<string, unknown>) };
  const window = { ...(draft.window as Record<string, unknown>) };
  delete window.endIso;
  return checkProposal(parseSpec({ ...draft, status: 'DRAFT', version: 1, window }, 'llm proposal'), taken);
}

/** Limits every model-written spec must meet: id prefix, unused id, known symbols, evaluator params and policy floors. */
export function checkProposal(spec: HypothesisSpec, taken: Set<string>): HypothesisSpec {
  if (!spec.id.startsWith(PROPOSAL_ID_PREFIX)) throw new Error(`${spec.id}: id must start with ${PROPOSAL_ID_PREFIX}`);
  if (taken.has(`${spec.id}@${spec.version}`)) throw new Error(`${spec.id}: id already exists`);
  const stray = spec.symbols.filter((s) => !RESEARCH_SYMBOLS.includes(s));
  if (stray.length) throw new Error(`${spec.id}: unknown symbols ${stray.join(',')}`);
  readParams(spec);
  checkFloors(spec);
  return spec;
}

function checkFloors(spec: HypothesisSpec): void {
  const f = PROPOSAL_FLOORS;
  const problems = [
    spec.costs.roundTripBps < f.minRoundTripBps && `costs.roundTripBps ${spec.costs.roundTripBps} < ${f.minRoundTripBps}`,
    spec.evidence.minOosTrades < f.minOosTrades && `evidence.minOosTrades ${spec.evidence.minOosTrades} < ${f.minOosTrades}`,
    spec.evidence.alpha > f.maxAlpha && `evidence.alpha ${spec.evidence.alpha} > ${f.maxAlpha}`,
    (spec.window.days < f.minDays || spec.window.days > f.maxDays) && `window.days ${spec.window.days} outside ${f.minDays}..${f.maxDays}`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`${spec.id}: ${problems.join('; ')}`);
}

function draftsIn(text: string): unknown[] {
  const parsed = parseJsonLoose(text) as { proposals?: unknown };
  if (!Array.isArray(parsed.proposals)) throw new Error('reply has no "proposals" array');
  return parsed.proposals;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0]! : String(error));

const describeSpec = (spec: HypothesisSpec): string =>
  `${spec.id} · ${spec.symbols.join(',')} · ${spec.timeframes.join(',')} · ${JSON.stringify(spec.params)} · ${spec.window.days}d · ${spec.hypothesis.slice(0, 120)}`;

function acceptDrafts(reply: string, wanted: number, taken: Set<string>): { accepted: HypothesisSpec[]; rejected: string[] } {
  let drafts: unknown[];
  try { drafts = draftsIn(reply); } catch (error) { return { accepted: [], rejected: [reasonOf(error)] }; }
  const accepted: HypothesisSpec[] = [];
  const rejected: string[] = [];
  for (const raw of drafts.slice(0, wanted)) {
    try {
      const spec = checkDraft(raw, taken);
      taken.add(`${spec.id}@${spec.version}`);
      accepted.push(spec);
    } catch (error) {
      rejected.push(reasonOf(error));
    }
  }
  return { accepted, rejected };
}

/** Asks the model for `count` drafts, with one repair round for rejected ones. LLM transport errors propagate to the caller. */
export async function proposeSpecs(args: ProposeArgs): Promise<ProposeResult> {
  const log = args.log ?? (() => undefined);
  const taken = new Set(args.existing.map((s) => `${s.id}@${s.version}`));
  const proposals: HypothesisSpec[] = [];
  const attempts: ProposalAttempt[] = [];
  let repairs: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && proposals.length < args.count; attempt += 1) {
    const wanted = args.count - proposals.length;
    const prompt = buildPrompt(args, wanted, repairs);
    log(`asking ${args.model} for ${wanted} draft(s), attempt ${attempt}/${MAX_ATTEMPTS}, timeout ${LLM_TIMEOUT_MS / 1000}s`);
    const startedMs = Date.now();
    const reply = await args.client.generateText({ model: args.model, prompt, timeoutMs: LLM_TIMEOUT_MS });
    const latencyMs = Date.now() - startedMs;
    const { accepted, rejected } = acceptDrafts(reply, wanted, taken);
    log(`reply in ${(latencyMs / 1000).toFixed(1)}s (${reply.length} chars): ${accepted.length} accepted, ${rejected.length} rejected`);
    for (const spec of accepted) log(`  ok ${describeSpec(spec)}`);
    for (const reason of rejected) log(`  rejected: ${reason}`);
    proposals.push(...accepted);
    attempts.push({ attempt, prompt, reply, latencyMs, accepted: accepted.map((spec) => spec.id), rejected });
    repairs = rejected;
  }
  return { proposals, rejected: attempts.flatMap((a) => a.rejected), attempts };
}

/** One `<id>.json` per proposal; an existing file is never overwritten. Returns the paths written. */
export function writeProposals(specs: HypothesisSpec[], dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const spec of specs) {
    const file = path.join(dir, `${spec.id}.json`);
    if (existsSync(file)) continue;
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    written.push(file);
  }
  return written;
}
