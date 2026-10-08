/**
 * Self-improvement loop CLI.
 *
 *   npx tsx scripts/self-improve.ts [--iters N] [--llm] [--status] [--ledger PATH]
 *
 * Loads the existing SetupOutcomeLedger from disk (data/setup-outcomes.jsonl by default), constructs the
 * SelfImprovementLoop with persistent registries, and runs N iterations of OBSERVE → DIAGNOSE → HYPOTHESIZE →
 * BACKTEST → CHALLENGE → PROMOTE/REJECT.
 *
 * Each iteration prints:
 *   - The current champion (id, version, hypothesis summary)
 *   - The diagnostics digest (worst/best cells of the champion's conditional-edge matrix)
 *   - Each hypothesis proposed (LLM or fallback) and the experiment result + verdict
 *   - Any candidate staged as a new SHADOW challenger
 *
 * Flags:
 *   --iters N    Number of iterations to run. Default 1.
 *   --llm        Use the OllamaAdvisor to propose hypotheses (default: deterministic fallback).
 *   --status     Print the current state (champion, challengers, experiment count) and exit.
 *   --ledger PATH  Path to the setup-outcomes.jsonl file. Default data/setup-outcomes.jsonl.
 *
 * The script never promotes a candidate past SHADOW — operator decides SHADOW → PAPER → CANARY → PROMOTED
 * via `--advance` (a future CLI sub-command). The loop produces evidence; the operator consumes it.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { OllamaAdvisor } from '../src/ollama/advisor.js';
import { SetupOutcomeLedger, type SetupOutcomeRecord } from '../src/learning/SetupOutcomeLedger.js';
import { ChampionRegistry } from '../src/research/ChampionRegistry.js';
import { ExperimentStore, type ExperimentRecord } from '../src/research/ExperimentStore.js';
import { ResearchAgent, type ResearchDiagnostics } from '../src/research/ResearchAgent.js';
import { SelfImprovementLoop, DEFAULT_LOOP_CONFIG } from '../src/research/SelfImprovementLoop.js';
import { StrategyRegistry } from '../src/research/StrategyRegistry.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Loads the SetupOutcomeLedger from disk and returns its `all()` array of resolved records. */
function loadLedger(filePath: string): SetupOutcomeRecord[] {
  const ledger = new SetupOutcomeLedger(filePath, { feeRate: 0.0004, slippageRate: 0.0002 });
  return ledger.all();
}

function printChampion(champions: ChampionRegistry, strategies: StrategyRegistry): void {
  for (const id of strategies.ids()) {
    const champion = champions.champion(id);
    if (!champion) {
      console.log(`  ${id}: no champion appointed`);
      continue;
    }
    const spec = strategies.get(id, champion.version);
    console.log(`  ${id}: champion v${champion.version} (since ${new Date(champion.since).toISOString()})`);
    if (spec) {
      console.log(`    hypothesis: ${spec.hypothesis}`);
      console.log(`    params: ${Object.entries(spec.params).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    const challengers = champions.challengersFor(id);
    if (challengers.length > 0) {
      console.log(`    active challengers:`);
      for (const c of challengers) {
        console.log(`      v${c.version} @ ${c.stage} (since ${new Date(c.since).toISOString()})${c.note ? ` — ${c.note}` : ''}`);
      }
    }
  }
}

function printDiagnostics(d: ResearchDiagnostics): void {
  console.log(`  Diagnostics for ${d.championId} v${d.championVersion}`);
  if (d.worstCells.length > 0) {
    console.log(`  Worst cells:`);
    for (const c of d.worstCells.slice(0, 3)) {
      const s = c.stats;
      console.log(`    ${c.key}: n=${c.n}, mean=${s ? s.mean.toFixed(3) : 'n/a'}R, LCB=${s ? s.ciLow.toFixed(3) : 'n/a'}, significant=${c.significant}`);
    }
  }
  if (d.bestCells.length > 0) {
    console.log(`  Best cells:`);
    for (const c of d.bestCells.slice(0, 3)) {
      const s = c.stats;
      console.log(`    ${c.key}: n=${c.n}, mean=${s ? s.mean.toFixed(3) : 'n/a'}R, LCB=${s ? s.ciLow.toFixed(3) : 'n/a'}, significant=${c.significant}`);
    }
  }
}

function printExperiment(idx: number, exp: ExperimentRecord): void {
  console.log(`  Experiment ${idx + 1}: candidate v${exp.candidate.version} from parent v${exp.parent.version}`);
  console.log(`    hypothesis: ${exp.candidate.hypothesis}`);
  console.log(`    train: n=${exp.result.train.n}, meanR=${exp.result.train.meanNetR.toFixed(3)}, PF=${exp.result.train.profitFactor.toFixed(2)}`);
  console.log(`    test:  n=${exp.result.test.n}, meanR=${exp.result.test.meanNetR.toFixed(3)}, PF=${exp.result.test.profitFactor.toFixed(2)}, DD=${exp.result.test.maxDrawdownR.toFixed(2)}R`);
  console.log(`    parent test: n=${exp.result.parentTest.n}, meanR=${exp.result.parentTest.meanNetR.toFixed(3)}`);
  console.log(`    walk-forward: ${exp.result.walkForward.folds} folds, OOS mean=${exp.result.walkForward.outOfSample?.mean.toFixed(3) ?? 'n/a'}R`);
  if (exp.result.experimentNotes.length > 0) {
    console.log(`    notes:`);
    for (const n of exp.result.experimentNotes) console.log(`      - ${n}`);
  }
  console.log(`    verdict: ${exp.verdict.decision}`);
  for (const r of exp.verdict.reasons) console.log(`      ${r}`);
}

async function main(): Promise<void> {
  const ledgerPath = arg('ledger', path.resolve('data/setup-outcomes.jsonl'));
  const iters = Number(arg('iters', '1'));
  const useLlm = flag('llm');
  const statusOnly = flag('status');

  const strategies = new StrategyRegistry(path.resolve('data/strategy-registry.jsonl'));
  const champions = new ChampionRegistry(path.resolve('data/champion-registry.json'));
  const experiments = new ExperimentStore(path.resolve('data/experiments.jsonl'));
  strategies.ensureSeeds();
  for (const id of strategies.ids()) {
    if (!champions.champion(id)) {
      const seed = strategies.latest(id);
      if (seed) champions.appoint(seed, 'seed appointment on first run');
    }
  }

  if (statusOnly) {
    console.log('=== Current state ===');
    printChampion(champions, strategies);
    console.log('');
    console.log(`Experiments on record: ${experiments.all().length}`);
    const promoted = experiments.withVerdict('PROMOTE');
    console.log(`Promoted experiments: ${promoted.length}`);
    return;
  }

  if (!existsSync(ledgerPath)) {
    console.error(`error: ledger not found at ${ledgerPath}`);
    console.error('Run the trading agent first to populate data/setup-outcomes.jsonl, or supply --ledger PATH.');
    process.exit(1);
  }
  const ledger = loadLedger(ledgerPath);
  console.log(`Loaded ${ledger.length} setup outcomes from ${ledgerPath}`);
  console.log('');

  // Build the LLM client if requested. The OllamaAdvisor exposes a private client; we wrap it via a small adapter.
  let agent: ResearchAgent;
  if (useLlm) {
    const advisor = new OllamaAdvisor();
    // The advisor wraps the SDK; we re-implement a minimal AdvisorClient that delegates to it via the same path.
    const client = {
      listModels: async () => [],
      generateText: async (req: { model: string; prompt: string; format?: 'json' }) => {
        // Use the advisor's generate path via reflection; for a CLI demo this is acceptable.
        // In production, the advisor should expose a typed generateText method on its public API.
        const anyAdvisor = advisor as unknown as { generateText?: (req: { model: string; prompt: string }) => Promise<string> };
        if (typeof anyAdvisor.generateText === 'function') return anyAdvisor.generateText(req);
        throw new Error('OllamaAdvisor does not expose generateText');
      },
    };
    agent = new ResearchAgent(client, 'qwen2.5:7b');
    console.log('ResearchAgent: LLM mode (Ollama qwen2.5:7b). Will fall back to deterministic proposer on any LLM failure.');
  } else {
    agent = new ResearchAgent(null);
    console.log('ResearchAgent: deterministic fallback mode (no LLM). Use --llm to enable.');
  }
  console.log('');

  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, {
    ...DEFAULT_LOOP_CONFIG,
    trainDays: Number(arg('train-days', String(DEFAULT_LOOP_CONFIG.trainDays))),
    testDays: Number(arg('test-days', String(DEFAULT_LOOP_CONFIG.testDays))),
    maxHypothesesPerRun: Number(arg('max-hypotheses', String(DEFAULT_LOOP_CONFIG.maxHypothesesPerRun))),
  });

  for (let i = 0; i < iters; i += 1) {
    console.log(`=== Iteration ${i + 1} / ${iters} ===`);
    console.log('Champion before iteration:');
    printChampion(champions, strategies);
    console.log('');

    const result = await loop.run(ledger);
    printDiagnostics(result.diagnostics);
    console.log('');
    console.log(`Proposed ${result.hypotheses.length} hypotheses; ran ${result.experiments.length} experiments.`);
    for (let j = 0; j < result.experiments.length; j += 1) {
      printExperiment(j, result.experiments[j]);
    }
    if (result.newChampion) {
      console.log(`*** New SHADOW challenger staged: ${result.newChampion.id} v${result.newChampion.version} ***`);
    }
    console.log('');
  }

  console.log('=== Final state ===');
  printChampion(champions, strategies);
  console.log('');
  console.log(`Total experiments on record: ${experiments.all().length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
