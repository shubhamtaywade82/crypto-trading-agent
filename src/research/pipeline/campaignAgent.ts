/**
 * Autonomous research session for one campaign (`research:run --agent <CAMPAIGN_ID>`), on the ollama-sdk Agent loop.
 *
 * The model works through four tools: list_specs (campaign state and journal memory), draft_spec, evaluate_draft
 * (train/validation only) and shortlist_spec. Every limit is enforced inside a tool, never by the prompt: drafts get the
 * campaign window and per-spec alpha, evaluations never compute the test segment and spend a campaign-wide budget, and
 * shortlisting is capped at the campaign's registration budget. Registering, the only step that reads a test window, stays
 * a human edit.
 */
import { Agent, ToolRegistry, defineTool, type AgentChatClient, type AgentHooks, type AgentTurn } from '@nemesis-oss/ollama-sdk';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Candle } from '../../types.js';
import {
  appendJournal, readJournal, registrationAlpha, shapeProblems,
  type Campaign, type JournalEntry, type SegmentSummary, type SeriesSummary,
} from './campaign.js';
import { evaluateSpec, SUPPORTED_CONTEXT, SUPPORTED_FAMILY, type SegmentStats, type SeriesInput } from './evaluate.js';
import { loadSpecs, parseSpec, RESEARCH_TIMEFRAMES, type HypothesisSpec, type LoadedSpec } from './hypothesis.js';
import { checkProposal, writeProposals } from './propose.js';
import { fetchBinanceMetrics } from './binanceDataTools.js';
import { executeResearchScript } from './scriptExecutorTool.js';

const MAX_ITERATIONS = 40;
const MAX_TOOL_CALLS = 150;
/** The SDK fails the run when one identical call repeats past this: the stuck-loop signature. */
const MAX_REPEATED_TOOL_CALLS = 2;
/** One evaluation fetches up to 12 multi-year series; ~5s each on the API, slower on the archive. */
const TOOL_TIMEOUT_MS = 300_000;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
/** Binance USDⓈ-M taker is ~5 bps a side; 15 bps leaves room for slippage. Same default as the hand-written specs. */
const DEFAULT_ROUND_TRIP_BPS = 15;
const DEFAULT_MIN_OOS_TRADES = 100;
const DAY_MS = 86_400_000;
const LOG_PREVIEW_CHARS = 300;

export interface AgentContext {
  campaign: Campaign;
  specsDir: string;
  proposedDir: string;
  journalFile: string;
  /** Passed to the evaluator for completeness; DRAFT evaluations never read or write it. */
  ledgerFile: string;
  runId: string;
  loadCandles: (symbol: string, timeframe: string, fromMs: number, toMs: number) => Promise<Candle[]>;
  log: (line: string) => void;
}

export interface AgentRunReport {
  finalText: string | null;
  turns: AgentTurn[];
  error: string | null;
}

const nowIso = (): string => new Date().toISOString();
const oneLine = (text: string, max = LOG_PREVIEW_CHARS): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const round = (value: number | undefined): number | null => (value === undefined ? null : Math.round(value * 10_000) / 10_000);

function specsOnDisk(ctx: AgentContext): LoadedSpec[] {
  return [...loadSpecs(ctx.specsDir), ...(existsSync(ctx.proposedDir) ? loadSpecs(ctx.proposedDir) : [])];
}

function findSpec(ctx: AgentContext, id: string): LoadedSpec {
  const matches = specsOnDisk(ctx).filter((s) => s.spec.id === id).sort((a, b) => b.spec.version - a.spec.version);
  if (!matches[0]) throw new Error(`unknown spec id "${id}"; call list_specs for the exact ids`);
  return matches[0];
}

type Evaluation = Extract<JournalEntry, { kind: 'evaluation' }>;
const evaluationsIn = (journal: JournalEntry[]): Evaluation[] => journal.filter((e): e is Evaluation => e.kind === 'evaluation');
const shortlistIn = (journal: JournalEntry[]): string[] => journal.filter((e) => e.kind === 'shortlist').map((e) => e.specId);

function campaignState(ctx: AgentContext): unknown {
  const { campaign } = ctx;
  const journal = readJournal(ctx.journalFile);
  const evaluations = evaluationsIn(journal);
  const shortlisted = shortlistIn(journal);
  return {
    campaign: {
      id: campaign.id, description: campaign.description, window: campaign.window, symbols: campaign.symbols, timeframes: campaign.timeframes,
      evaluationsUsed: evaluations.length, evaluationsLeft: campaign.maxEvaluations - evaluations.length,
      shortlisted, shortlistSlotsLeft: campaign.maxRegistrations - shortlisted.length,
    },
    specs: specsOnDisk(ctx).map(({ spec, hash }) => ({
      id: spec.id, status: spec.status, campaign: spec.campaign ?? null, symbols: spec.symbols, timeframes: spec.timeframes,
      params: spec.params, hypothesis: spec.hypothesis,
      validationEvidence: evaluations.filter((e) => e.specId === spec.id && e.specHash === hash).at(-1)?.series ?? null,
    })),
  };
}

const draftInput = z.object({
  id: z.string().describe('New unique id: uppercase letters, digits, "_" or "-", starting with "LLM-"'),
  hypothesis: z.string().describe('The market mechanism that would make the edge real, stated before any result'),
  symbols: z.array(z.string()).min(1).describe('Subset of the campaign symbols'),
  timeframes: z.array(z.enum(RESEARCH_TIMEFRAMES)).min(1).describe('Subset of the campaign timeframes'),
  params: z.object({
    trigger: z.enum(['DONCHIAN_BREAK', 'EMA_CROSS', 'PULLBACK_RECLAIM', 'SQUEEZE_EXPANSION', 'MACD_CROSS', 'STOCH_CROSS']).default('DONCHIAN_BREAK').optional().describe('Pattern or trigger mechanism'),
    regimeFilter: z.enum(['NONE', 'TREND_EMA_50_200', 'SUPERTREND_REGIME', 'ADX_TRENDING', 'RSI_MOMENTUM', 'VOLUME_SURGE', 'VOL_AND_TREND', 'LOW_VOL_EXPANSION']).default('NONE').optional().describe('Market regime or confluence filter'),
    direction: z.enum(['LONG', 'SHORT', 'BOTH']).default('LONG').optional().describe('Trade direction'),
    lookback: z.number().int().optional().describe('Lookback period (e.g. 20 for Donchian)'),
    fastPeriod: z.number().int().optional().describe('Fast EMA period (e.g. 9 or 20)'),
    slowPeriod: z.number().int().optional().describe('Slow EMA period (e.g. 21 or 50)'),
    targetPct: z.number().optional().describe('Target move in percent (e.g. 1.0 to 10.0)'),
    targetR: z.number().optional().describe('Target in multiples of stop distance'),
    stopAtr: z.number().optional().describe('Stop distance in ATR14 multiples'),
    rrRatio: z.number().optional().describe('Alternative stop distance: targetDist / rrRatio'),
    useBreakeven: z.boolean().optional().describe('Trail stop to entry at +50% target distance'),
    maxHoldingBars: z.number().int().default(18).optional().describe('Time exit after this many bars'),
  }),
  roundTripBps: z.number().optional().describe(`Round-trip cost in bps, default ${DEFAULT_ROUND_TRIP_BPS}, minimum 10`),
  minOosTrades: z.number().int().optional().describe(`Test trades needed per series, default ${DEFAULT_MIN_OOS_TRADES}, minimum 100`),
});

/** A full spec from the model's fields; window, family, context, campaign and alpha come from the campaign, never the model. */
function buildDraft(campaign: Campaign, input: z.infer<typeof draftInput>): HypothesisSpec {
  const trigger = input.params.trigger ?? 'DONCHIAN_BREAK';
  const regime = input.params.regimeFilter ?? 'LOW_VOL_EXPANSION';
  return parseSpec({
    schemaVersion: 1, id: input.id, version: 1, status: 'DRAFT', hypothesis: input.hypothesis,
    family: trigger,
    symbols: input.symbols, timeframes: input.timeframes, timeframeRule: 'each timeframe tested independently',
    context: { id: regime, taxonomyVersion: 'ctx-v1' }, campaign: campaign.id, params: input.params,
    window: { days: campaign.window.days, endDaysAgo: 0, endIso: campaign.window.endIso, split: campaign.window.split },
    costs: { roundTripBps: input.roundTripBps ?? DEFAULT_ROUND_TRIP_BPS },
    evidence: { minOosTrades: input.minOosTrades ?? DEFAULT_MIN_OOS_TRADES, alpha: registrationAlpha(campaign) },
  }, 'agent draft');
}

function draftSpec(ctx: AgentContext, input: z.infer<typeof draftInput>): unknown {
  const spec = checkProposal(buildDraft(ctx.campaign, input), new Set(specsOnDisk(ctx).map((s) => `${s.spec.id}@${s.spec.version}`)));
  const problems = shapeProblems(spec, ctx.campaign);
  if (problems.length) throw new Error(`${spec.id}: ${problems.join('; ')}`);
  if (writeProposals([spec], ctx.proposedDir).length === 0) throw new Error(`${spec.id}: a file with this id already exists; pick a new id`);
  appendJournal(ctx.journalFile, { kind: 'draft', atIso: nowIso(), runId: ctx.runId, specId: spec.id, specHash: findSpec(ctx, spec.id).hash });
  return { drafted: spec.id, window: spec.window, evidence: spec.evidence, next: `evaluate_draft {"id":"${spec.id}"}` };
}

const summarize = (segment: SegmentStats): SegmentSummary => ({
  trades: segment.trades, days: segment.summary?.clusters ?? null, meanR: round(segment.summary?.mean),
  ciLow: round(segment.summary?.ciLow), ciHigh: round(segment.summary?.ciHigh), pValue: round(segment.summary?.pValue),
});

async function loadSeries(ctx: AgentContext, spec: HypothesisSpec): Promise<SeriesInput[]> {
  const toMs = Date.parse(ctx.campaign.window.endIso);
  const fromMs = toMs - ctx.campaign.window.days * DAY_MS;
  const series: SeriesInput[] = [];
  for (const symbol of spec.symbols) {
    for (const timeframe of spec.timeframes) series.push({ symbol, timeframe, candles: await ctx.loadCandles(symbol, timeframe, fromMs, toMs) });
  }
  return series;
}

/** Checks that must pass before an evaluation spends budget: a known DRAFT of this campaign, in its shape, budget left. */
function evaluableSpec(ctx: AgentContext, id: string, journal: JournalEntry[]): LoadedSpec {
  const found = findSpec(ctx, id);
  const { spec } = found;
  if (spec.campaign !== ctx.campaign.id) throw new Error(`${id} is not a ${ctx.campaign.id} spec; draft a campaign version with draft_spec`);
  if (spec.status !== 'DRAFT') throw new Error(`${id} is ${spec.status}; the agent evaluates DRAFT specs only`);
  const problems = shapeProblems(spec, ctx.campaign);
  if (problems.length) throw new Error(`${id}: ${problems.join('; ')}`);
  const used = evaluationsIn(journal).length;
  if (used >= ctx.campaign.maxEvaluations) throw new Error(`campaign evaluation budget spent (${used}/${ctx.campaign.maxEvaluations})`);
  return found;
}

async function evaluateDraft(ctx: AgentContext, id: string): Promise<unknown> {
  const journal = readJournal(ctx.journalFile);
  const cached = evaluationsIn(journal).find((e) => e.specId === id && e.specHash === findSpec(ctx, id).hash);
  if (cached) return { id, cached: true, series: cached.series };
  const { spec, hash } = evaluableSpec(ctx, id, journal);
  const result = evaluateSpec({ spec, hash, series: await loadSeries(ctx, spec), ledgerFile: ctx.ledgerFile, runId: ctx.runId, readAtIso: nowIso() });
  // A DRAFT never reads its test segment; if that ever changes, refuse to hand the numbers to the model.
  if (result.series.some((s) => s.test !== null)) throw new Error(`internal error: evaluating ${id} produced test statistics`);
  const series: SeriesSummary[] = result.series.map((s) => ({ symbol: s.symbol, timeframe: s.timeframe, train: summarize(s.train), validation: summarize(s.validation) }));
  appendJournal(ctx.journalFile, { kind: 'evaluation', atIso: nowIso(), runId: ctx.runId, specId: id, specHash: hash, series });
  return { id, series, evaluationsLeft: ctx.campaign.maxEvaluations - evaluationsIn(journal).length - 1 };
}

function shortlistSpec(ctx: AgentContext, id: string, rationale: string): unknown {
  const journal = readJournal(ctx.journalFile);
  const { spec, hash } = findSpec(ctx, id);
  if (spec.campaign !== ctx.campaign.id) throw new Error(`${id} is not a ${ctx.campaign.id} spec`);
  if (!evaluationsIn(journal).some((e) => e.specId === id && e.specHash === hash)) throw new Error(`${id} has no evaluation yet; run evaluate_draft first`);
  const shortlisted = shortlistIn(journal);
  if (shortlisted.includes(id)) throw new Error(`${id} is already shortlisted`);
  if (shortlisted.length >= ctx.campaign.maxRegistrations) throw new Error(`no shortlist slots left (${shortlisted.length}/${ctx.campaign.maxRegistrations})`);
  appendJournal(ctx.journalFile, { kind: 'shortlist', atIso: nowIso(), runId: ctx.runId, specId: id, specHash: hash, rationale });
  return { shortlisted: id, slotsLeft: ctx.campaign.maxRegistrations - shortlisted.length - 1, next: 'a human decides whether to register it (that reads the test window once)' };
}

export function buildTools(ctx: AgentContext): ToolRegistry {
  return new ToolRegistry({
    timeoutMs: TOOL_TIMEOUT_MS, maxConcurrency: 1, maxOutputChars: MAX_TOOL_OUTPUT_CHARS,
    tools: [
      defineTool({ name: 'list_specs', description: 'Campaign window and budgets, the shortlist, and every spec on disk with its latest train/validation evidence. Call first.', schema: z.object({}), execute: async () => campaignState(ctx) }),
      defineTool({ name: 'draft_spec', description: 'Write a new DRAFT spec for this campaign. Window, family, context and alpha are set by the campaign.', schema: draftInput, execute: async (input) => draftSpec(ctx, input) }),
      defineTool({ name: 'evaluate_draft', description: 'Backtest a campaign DRAFT on its train and validation segments (never test). Spends one campaign evaluation unless cached.', schema: z.object({ id: z.string() }), execute: async ({ id }) => evaluateDraft(ctx, id) }),
      defineTool({ name: 'shortlist_spec', description: 'Recommend an evaluated campaign draft for human registration. Uses one of the campaign registration slots.', schema: z.object({ id: z.string(), rationale: z.string().min(20) }), execute: async ({ id, rationale }) => shortlistSpec(ctx, id, rationale) }),
      defineTool({ name: 'fetch_binance_metrics', description: 'Fetch live Binance USD-M futures metrics: funding rate, open interest, and long/short positioning ratios for a symbol.', schema: z.object({ symbol: z.string() }), execute: async ({ symbol }) => fetchBinanceMetrics(symbol) }),
      defineTool({ name: 'execute_research_script', description: 'Run a sandboxed TypeScript research script with tsx to test custom formulas, inspect data, or verify indicators.', schema: z.object({ code: z.string(), description: z.string() }), execute: async ({ code }) => executeResearchScript(code) }),
    ],
  });
}

export function systemPrompt(campaign: Campaign): string {
  const { window } = campaign;
  return `You run autonomous strategy research for a crypto-futures research pipeline in campaign ${campaign.id}: ${campaign.description}
Discover working trading regimes, patterns, confluences, and risk/reward profiles across symbols (${campaign.symbols.join(' ')}) and timeframes (${campaign.timeframes.join(' ')}).
Available discovery tools:
- list_specs: Inspect current campaign progress, evaluation budget, and past evidence.
- fetch_binance_metrics: Query live Binance USD-M market metrics (funding rate, open interest, taker ratio).
- execute_research_script: Run exploratory TypeScript scripts in a sandbox to calculate custom metrics or verify logic.
- draft_spec: Propose a quantitative trading hypothesis (triggers, regimes, target % 1-10, stops).
- evaluate_draft: Rigorously simulate on train/validation segments. The test segment stays strictly unread.
- shortlist_spec: Recommend statistically verified winning hypotheses for human registration.
Process:
1. Call list_specs. Inspect past evaluations and avoid repeating negative setups.
2. Check market metrics or execute scratch analysis scripts if needed to confirm market regime hypotheses.
3. Draft 1-3 distinct specs with clear hypotheses testing different regimes and triggers.
4. Call evaluate_draft to simulate on train/validation data. Inspect win rate, trade count, and net R.
5. Refine promising setups (e.g. volume surge, trend filter, 1.5% to 5.0% target moves).
6. Shortlist only specs with positive validation expectancy (mean Net R > 0) and sufficient sample size.
7. Provide a concise summary of your findings across regimes and strategies.`;
}

function agentHooks(ctx: AgentContext, turns: AgentTurn[]): AgentHooks {
  const startedAt = new Map<string, number>();
  return {
    onTurnStart: (iteration) => ctx.log(`turn ${iteration}`),
    onToolCallStart: (call) => {
      startedAt.set(call.id ?? call.function.name, Date.now());
      ctx.log(`-> ${call.function.name} ${oneLine(JSON.stringify(call.function.arguments))}`);
    },
    onToolCallEnd: (result) => {
      const seconds = ((Date.now() - (startedAt.get(result.toolCallId ?? result.toolName) ?? Date.now())) / 1000).toFixed(1);
      ctx.log(`<- ${result.toolName} ${result.success ? 'ok' : 'ERROR'} (${seconds}s) ${oneLine(result.outputString)}`);
    },
    onTurnEnd: (turn) => {
      turns.push(turn);
      if (turn.message.thinking) ctx.log(`thinking: ${oneLine(turn.message.thinking)}`);
      if (!turn.toolCalls?.length && turn.message.content) ctx.log(`says: ${oneLine(turn.message.content)}`);
    },
  };
}

/** One bounded session. Never throws for model or loop failures: they come back in `error`, with every turn so far. */
export async function runCampaignAgent(ctx: AgentContext, client: AgentChatClient, model: string): Promise<AgentRunReport> {
  const turns: AgentTurn[] = [];
  const agent = new Agent(client, {
    tools: buildTools(ctx), maxIterations: MAX_ITERATIONS, maxToolCalls: MAX_TOOL_CALLS,
    maxRepeatedToolCalls: MAX_REPEATED_TOOL_CALLS, hooks: agentHooks(ctx, turns),
  });
  const messages = [
    { role: 'system' as const, content: systemPrompt(ctx.campaign) },
    { role: 'user' as const, content: `Run one research session for campaign ${ctx.campaign.id} now.` },
  ];
  try {
    const result = await agent.run({ model, messages });
    return { finalText: result.finalMessage.content, turns, error: null };
  } catch (error) {
    return { finalText: null, turns, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
