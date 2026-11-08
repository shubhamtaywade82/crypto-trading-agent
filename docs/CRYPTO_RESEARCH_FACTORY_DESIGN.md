# Crypto Strategy Research Factory — Design and Delivery Plan

**Status:** Design baseline; implementation not yet started  
**Base:** main at fce8afd0cad347d2e9dbb0ecebfbaf43889295e0  
**Scope:** Binance USD-M perpetual futures. Primary trading universe: SOLUSDT, ETHUSDT and XRPUSDT; BTCUSDT is the market-context anchor. Venue-specific execution adapters remain separate.

## 1. Objective

Build the complete research-to-production lifecycle shown in the reference workflow:

Market Data → Strategy Generation → Parallel Backtests → Multi-Factor Evaluation → AI Research → OOS / Walk-Forward Validation → Shadow / Paper / Canary → Live Monitoring → Controlled Improvement.

This extends the current system; it does not replace it. The trading core remains the only authority for market state, risk decisions, order placement and portfolio state. The research factory discovers and validates candidates. It cannot bypass the risk engine, live-readiness checks, strategy approval registry, kill switch or venue protections.

The system must evaluate large candidate batches (50,000 is an upper-bound example, not a mandatory target), produce deterministic and auditable results, and promote only candidates that survive untouched out-of-sample evaluation and forward paper evidence.

## 2. Repository audit — existing capabilities

Verified on the base commit above.

| Capability | Existing implementation | Assessment |
|---|---|---|
| Market data and regime/context | src/market, src/marketdata, Binance USD-M adapters, historical archive/manifests | Reuse. Preserve provenance and the current Context Strategy research pipeline. |
| Full-system historical replay | src/backtesting/ReplayService.ts, MarketDataFeed.ts, ExecutionSimulator.ts, PortfolioSimulator.ts and replay metrics/tests | Reuse as the canonical evaluator for candidates requiring full execution semantics. |
| Setup-level research replay | src/research/ExperimentRunner.ts, SetupOutcomeLedger, ConditionalEdge | Reuse for the STRUCT-LIQ threshold research it was designed for; it is not a general strategy backtester. |
| Candidate parameter optimization | src/research/Optimizer.ts: deterministic random, grid and TPE-like sampling | Reuse primitives. The current self-improvement path does not wire this into a broad candidate-generation and execution pipeline. |
| Strategy specifications | src/research/StrategySpec.ts and StrategyRegistry.ts | Versioning and lineage exist, but SpecParams is currently STRUCT-LIQ-shaped. Other family names are placeholders, not working research adapters. |
| AI hypothesis generation | ResearchAgent.ts, ModelRouter.ts, HypothesisRepairLoop.ts, ExperimentMemory.ts | Reuse role separation and model routing. Current proposer is oriented around STRUCT-LIQ mutations. |
| Statistical promotion | PromotionGate.ts, Bootstrap.ts, SampleSize.ts, DeflatedSharpe.ts, Shrinkage.ts, StratifiedBaseline.ts | Reuse and extend. Do not weaken existing fail-closed behavior. |
| Champion lifecycle | ChampionRegistry.ts, liveReadiness.ts, strategy approvals | Reuse SHADOW/PAPER/CANARY/PROMOTED and operator-controlled live approval. |
| Research event/audit store | ExperimentStore.ts, ResearchLedger.ts, Events.ts and JSONL state | Reuse append-only lineage; add run/job/worker events and artifact references. |
| Research dashboard API | apps/dashboard/server/routes/research.ts | Read-only research endpoints already exist. |
| Research dashboard UI | App.tsx polls research data into the Zustand store, but the workspace renders no dedicated research panel | Add the research view; keep browser controls read-only. |
| Large-scale parallel runner | No general research job queue / worker pool was found under src/backtesting | New capability. |
| Multi-family strategy factory | No generic strategy-family contract + full-replay evaluator was found | New capability. |

### Current hard boundary

The current SelfImprovementLoop reads SetupOutcomeLedger, selects the STRUCT-LIQ-η champion explicitly, proposes a maximum of a few hypotheses per iteration, runs ExperimentRunner, and stages candidates as SHADOW. The runner mostly re-filters previously recorded hypothetical setups. It is exact for some threshold changes and explicitly approximate for sweep-age changes.

That is useful and should remain. It does not satisfy the general requirement to instantiate many distinct strategy variants and run each through the full portfolio/execution replay. The generic strategy factory must not pretend a post-hoc filter is equivalent to rerunning a changed entry/exit engine.

### Current evidence boundary

The latest Context Strategy V100 report in the audited tree classifies its run as RESEARCH_BLOCKED. It records archive/market-data maintenance but no strategy experiment and no untouched OOS evaluation, with zero OOS-validated candidates. Treat that report as blocked evidence, not a successful research result. New reports must preserve this distinction.

## 3. Target architecture

Separate the system into four planes with explicit contracts.

DATA PLANE
Binance USD-M REST + WebSocket + archived candles + recorded trades/book/mark/funding
→ Immutable data manifests + validation + feature-availability timestamps

RESEARCH PLANE
Strategy catalog → Candidate generator → Job planner → Bounded worker pool
→ Canonical full-system replay (signal → risk → execution → portfolio)
→ Result and metric store

EVALUATION + VALIDATION PLANE
Multi-factor ranking → shortlist → OOS → walk-forward → stability → cost stress

AI RESEARCH PLANE
Performance analyst / failure analyst / regime analyst / hypothesis agent
→ Typed strategy-spec proposals
→ Candidate generator (new, traceable experiment lineage)

PROMOTION + OPERATIONS PLANE
Rejected / Research-only / Shadow → Paper → Canary → Operator-approved Live
→ Monitoring, drift detection, risk alerts, rollback and research feedback

### Authority rules

1. The market-data service and immutable data manifests are the sole source of market facts.
2. The deterministic replay engine computes indicators, signals, fills, fees, funding, liquidation, PnL and risk. LLMs never compute these values.
3. Every experiment records its code revision, candidate spec hash, seed, data manifest IDs, cost model, execution model, timeframe, universe, date windows and engine version.
4. The LLM receives bounded diagnostic summaries and experiment artifacts. It may return a typed hypothesis or parameter mutation only.
5. A candidate cannot write to live approvals or place an order. Only the existing promotion/readiness/approval path can make a strategy live-eligible.
6. Missing, stale, partial, unaligned or invalid input yields INSUFFICIENT_DATA / NO_TRADE, never a neutral value or silent pass.

## 4. Strategy catalog and candidate contract

Introduce a family adapter contract instead of adding more STRUCT-LIQ-specific branches to ExperimentRunner.

Each adapter defines:

- Stable family ID and version.
- Parameter schema, ranges, constraints and conditional dependencies.
- Required features and minimum warm-up.
- Entry/exit semantics and stop/target policy identifiers.
- Supported symbols, timeframe combinations and market regimes.
- A deterministic buildCandidate(spec) / evaluateCandidate(spec, replayContext) path.
- Whether a mutation can be evaluated from an existing outcome ledger or requires a full replay.

Initial family onboarding order, subject to source audit and adapter feasibility:

1. STRUCT-LIQ — retain the current setup-ledger path; add full replay for mutations that alter setup creation or execution.
2. ALMA MTF — audit first because ALMA champion/agent and historical research/tests already exist.
3. Trend / momentum — onboard only when entry/exit parameters are fully represented in a serializable spec.
4. Mean reversion — same requirement; do not create an adapter from an agent name alone.
5. Crowding / flow strategies — require recorded historical flow/book/liquidation features with coverage manifests. Do not backtest unavailable historical features using current values or candle proxies.

Candidate identity is content-addressed from family + spec schema version + normalized parameters + strategy implementation version. An experiment identity additionally includes data manifest, execution-cost model, replay configuration, split definition and seed. Re-running the same immutable experiment must be idempotent.

## 5. Candidate generation at scale

Build a ResearchBatchPlanner on top of the existing optimizer primitives.

Supported generation modes:

- Exhaustive grid for small discrete spaces.
- Seeded random search for broad spaces.
- TPE-like adaptive search after a minimum warm-up sample.
- Hypothesis-directed local search, where AI proposes a parameter subset/direction and the optimizer samples that subspace.

Generation enforces parameter schemas, hard constraints, warm-up validity, deduplication and per-family budgets before a job is queued. Candidate generation is deterministic from an explicit seed and saved generator version.

A 50,000-candidate batch is a capacity target, not a performance claim. Candidate counts are recorded as generated, deduplicated, rejected by schema, queued, completed, failed, shortlisted and validated. A generated candidate is not a backtest result.

Use a staged funnel to control compute:

1. Static schema and data-coverage checks.
2. Cheap coarse screening on reduced windows only when labelled non-promotable.
3. Full replay for shortlisted candidates with realistic fees, spread, slippage, funding, next-bar/tick execution rules and portfolio constraints.
4. Statistical validation on pre-registered chronological splits.
5. Forward shadow/paper observation.

Only full replay and validation results may influence promotion.

## 6. Parallel execution and deterministic replay

Add a bounded local worker pool first; do not introduce a distributed queue until measurements show one host is insufficient.

Worker requirements:

- Workers execute immutable ResearchJob payloads and never access live order credentials.
- Each job includes spec hash, dataset manifest IDs, date window, costs, replay settings and deterministic seed.
- Job state: QUEUED → RUNNING → SUCCEEDED / FAILED / CANCELLED.
- Persist attempt number, worker ID, start/end time, error class, elapsed time and result-artifact checksum.
- Use at-least-once dispatch with idempotent result commit; duplicate deliveries must not duplicate experiment records.
- Retry transient worker/process failures only. Invalid data, invalid specs and deterministic engine errors are terminal.
- Checkpoint batches so restart resumes pending jobs without rerunning completed jobs.
- Cap concurrency and memory using measured replay cost; implement graceful shutdown and worker replacement.
- Aggregation verifies expected job count, candidate identity, data-manifest equality and checksums before marking a batch complete.

Workers call the existing TypeScript replay path and execution/portfolio simulators. The first version must not create a second, faster-but-different PnL implementation.

## 7. Evaluation framework

Separate ranking from promotion. A weighted score is useful for triage; it is not statistical proof and must never override hard gates.

| Dimension | Metrics |
|---|---|
| Performance | Net return, net expectancy (R and quote currency), profit factor, Sharpe, Sortino, trade count, average trade duration |
| Risk | Max drawdown, downside deviation, CVaR / expected shortfall, worst trade, losing streak, liquidation count, exposure and margin usage |
| Reliability | OOS performance, walk-forward fold distribution, parameter stability, regime consistency, symbol coverage, cost sensitivity |
| Execution quality | Fees, spread paid, slippage, fill assumptions, funding, turnover and latency sensitivity where recorded |
| Data quality | Missing bars, duplicates, OHLC validity, cross-symbol alignment, feature coverage and availability-time integrity |

Every metric states frequency, sample, units, gross/net basis and calculation version. Rank within comparable family/venue/universe/timeframe cohorts; do not compare incomparable strategies using one naïve score.

Hard filters are explicit and versioned. Preserve existing sample-size/power, cluster-bootstrap, DSR, shrinkage, regime, symbol-breadth and walk-forward protections. For a large search, multiple-testing accounting includes all trials that participated in selection, not merely the final shortlist. A failed or incomplete test is not a zero and not a pass.

## 8. Validation protocol

Each candidate follows an immutable protocol:

1. Pre-register hypothesis, family, search space, objective, costs, data windows and planned trial budget.
2. Use chronological train / validation / untouched test splits; purge overlapping outcome windows and embargo where trades/features can cross boundaries.
3. Use fixed walk-forward rules. No parameter changes based on the final untouched test.
4. Check parameter-neighbourhood stability and symbol/regime stability.
5. Re-run shortlisted candidates under conservative and stressed cost assumptions.
6. Compare against buy/hold where meaningful, a stratified random-entry baseline under identical costs, and the incumbent/champion.
7. Apply power/sample-size requirements, cluster-aware uncertainty and multiple-testing adjustment.
8. Preserve the untouched final test set. Once used for selection or tuning, it is no longer untouched and a new holdout is required.
9. Require forward shadow/paper evidence before any live approval.

Results use distinct classifications:
INVALID_DATA, INSUFFICIENT_DATA, REJECTED, RESEARCH_ONLY, OOS_VALIDATED, SHADOW, PAPER_VALIDATED, CANARY_ELIGIBLE, LIVE_APPROVED.
These classifications must not be collapsed into a single green checkmark.

## 9. AI research team

Use role-specialized agents over persisted facts, coordinated by a deterministic orchestrator.

| Role | Input | Output |
|---|---|---|
| Performance analyst | Batch metrics, benchmark deltas, equity curves | Return drivers and candidate cohorts |
| Failure analyst | Rejected candidates, failed trades, cost/risk attribution | Failure taxonomy and falsifiable explanations |
| Regime analyst | Results by volatility/regime/session/symbol | Regime-conditioned findings with sample counts |
| Hypothesis agent | Findings + prior experiment memory | Ranked, falsifiable hypotheses and expected direction |
| Strategy-spec agent | Approved hypothesis + adapter schema | Validated typed parameter mutations/candidate specs |
| Reviewer / skeptic | Hypothesis, evidence, prior trials | Contradictions, leakage risks, confounders and required tests |

LLM output is schema-validated, linked to source experiment IDs and persisted with model/provider/prompt version. Model failure must not stop deterministic research. No LLM role may invent missing data, change validation policy, edit live strategy implementation or waive a risk gate.

### Optional code sandbox

The sandbox is optional and isolated. The default path uses typed StrategySpec mutations, not generated executable code. A future code-generation path may create an untrusted patch in a disposable worktree/container, run security/static checks and tests, and produce a reviewable diff. It must never auto-merge, deploy or enable a live strategy. Disabling the sandbox must not disable typed-spec research.

## 10. Deployment, monitoring and continuous improvement

Reuse the existing champion lifecycle and live-readiness policy.

Lifecycle: DRAFT → RESEARCH → SHORTLIST → VALIDATING → SHADOW → PAPER → CANARY → PROMOTED.

Safety states: REJECTED, PAUSED, ROLLED_BACK, RETIRED.

- A statistical pass stages a candidate as SHADOW; it does not auto-promote it.
- Paper validation runs through the existing paper engine / paper_exchange path with the same strategy identity and decision lineage.
- Live promotion requires the existing evidence policy and explicit operator approval.
- Runtime monitoring tracks PnL/expectancy drift, drawdown, trade frequency, fill friction, funding, error rates, regime changes and divergence from replay expectations.
- A breach pauses new entries or rolls back to the prior approved champion; exits and risk-reducing actions remain available.
- Research changes cannot change account-level risk limits or weaken the risk engine.

## 11. Research dashboard

Extend the existing read-only dashboard, not the trading controls.

Add a Research workspace with:

- Batch status: generated / deduplicated / queued / running / completed / failed.
- Worker health, throughput, queue wait, replay duration and retry counts.
- Candidate funnel and filter reasons.
- Multi-factor leaderboard filtered by family, symbol, timeframe, regime and evaluation window.
- Equity curve comparisons with explicit in-sample / validation / OOS boundaries.
- Walk-forward fold distribution and parameter-stability heatmaps.
- Costs and execution assumptions for every run.
- AI research findings linked to supporting experiment IDs.
- Champion/challenger stage, paper evidence, readiness blockers and rollback events.

The UI remains read-only. Any operation changing run state, approvals, risk or execution stays in a separately authenticated CLI/operator path. Existing refreshResearch polling and /api/research/* endpoints are a foundation, but the current web workspace does not render a dedicated Research panel.

## 12. Delivery phases and acceptance criteria

### Phase 0 — Contracts and baseline
- Freeze current main baseline and record existing research/artifact manifests.
- Define ResearchRun, ResearchBatch, ResearchJob, CandidateSpec, ExperimentResult and status schemas.
- Validate immutable data/run manifests and candidate identity.
- Preserve the hourly Context Strategy automation and its data/report paths unchanged.

**Exit:** existing tests pass; manifests validate; no existing research job or schedule is modified.

### Phase 1 — Multi-family strategy adapters
- Keep STRUCT-LIQ setup-ledger evaluation.
- Add a full-replay adapter interface.
- Onboard one additional strategy family end to end (ALMA MTF is first for audit).
- Prove parameter mutations actually change generated signals, not just metadata.

**Exit:** adapter contract tests, deterministic replay equivalence, no-lookahead tests, and one family producing reproducible candidate results.

### Phase 2 — Batch generation and worker pool
- Compose the optimizer with candidate registry and job store.
- Add bounded worker execution, retries, checkpoint/resume and idempotent aggregation.
- Add load tests for throughput and memory; tune concurrency from measured data.

**Exit:** a seeded batch resumes after interruption and produces reproducible candidate/result identities for identical inputs.

### Phase 3 — Full replay and evaluation
- Evaluate each candidate through the canonical replay/portfolio execution path.
- Calculate versioned performance/risk/reliability/cost metrics.
- Add cohort leaderboard and non-promotable coarse screening.

**Exit:** replay results reconcile with existing backtest path on golden fixtures; all costs and portfolio constraints are accounted for.

### Phase 4 — Statistical validation
- Add immutable split manifests, purge/embargo, walk-forward, stability, baseline and multiple-testing accounting.
- Wire full portfolio equity curve into DSR where required.
- Preserve an untouched final test set.

**Exit:** leakage and multiple-testing tests fail closed; no candidate becomes OOS_VALIDATED without complete evidence.

### Phase 5 — AI research team
- Add analyst/reviewer roles, deterministic orchestration and typed proposal contracts.
- Link findings to experiment IDs and persist model/prompt provenance.
- Route model calls through existing Ollama SDK integration and configured local/cloud model router.

**Exit:** malformed proposals are rejected; model outages leave deterministic research available; LLM cannot alter execution/risk.

### Phase 6 — Research cockpit
- Render research dashboard using existing API/state contracts where possible.
- Add batch, worker, leaderboard, validation, champion and AI findings views.
- Add dashboard read-only contract tests.

**Exit:** operators can trace a candidate from generation through validation and promotion evidence without reading raw JSONL manually.

### Phase 7 — Controlled deployment and monitoring
- Wire shadow/paper/canary evidence to live-readiness.
- Add drift monitors, pause/rollback events and incident audit.
- Do not auto-write live approvals.

**Exit:** promotion and rollback tests prove research cannot bypass risk and execution authority boundaries.

## 13. Non-goals and explicit constraints

- Do not treat 50,000 generated parameter combinations as 50,000 independent strategies or evidence of edge.
- Do not use LLMs to fetch or calculate market data, indicators, PnL, execution quality or risk.
- Do not backtest flow strategies before required historical microstructure fields have adequate coverage.
- Do not compare spot prices with USD-M perpetual execution.
- Do not modify or disable the existing hourly Context Strategy automation as part of this project.
- Do not enable the MiniCPM trading fleet entry path merely to demonstrate deployment; the repository README currently documents entries as paused because that path is not wired through RiskEngine.
- Do not enable CoinDCX live execution until its live guard set is equivalent to Binance's.
- Do not automatically promote research findings to real-money trading.

## 14. Immediate implementation order

Start with Phase 0 contracts, then Phase 1 adapter contract + one ALMA MTF full-replay vertical slice. Do not start by building a 50,000-job queue. A scalable worker pool around a strategy contract that cannot faithfully reproduce candidate behaviour only scales invalid backtests.

The first demonstrable milestone is: one seed strategy + deterministic candidate batch + parallel full-system replay + multi-factor report + untouched OOS verdict + dashboard visibility, with no changes to live execution eligibility.
