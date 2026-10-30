/**
 * Fleet model registry: the curated shortlist of sub-4GB Ollama models the MiniCPM fleet can
 * swap in as its per-symbol trade-decision LLM, plus the resolution/parsing helpers that map
 * CLI/env specs to concrete Ollama tags.
 *
 * Design stance (docs/MINICPM_TRADING_FLEET.md "Model Selection"):
 *   1. MiniCPM5-2B stays the DEFAULT control model. Third-party benchmarks (JevBench, BFCL, ...)
 *      are not evidence this fleet performs better with a different model — a candidate model
 *      earns nothing until its own fleet ledger clears the same promotion gates as any strategy
 *      (npm run self-improve; docs/RESEARCH_SYSTEM.md). The registry records what each model is
 *      * marketed for, not what it has proven here.
 *   2. Any valid Ollama tag is accepted, registry or not — the registry adds metadata
 *      (size, role, notes) for the boot banner and docs; it never restricts choice.
 */

/** A curated shortlist entry. `id` is the stable key used by --model/--route. */
export interface FleetModel {
  /** Stable short id accepted by --model and --route (e.g. 'qwen3.5-2b'). */
  id: string;
  /** Exact Ollama tag to send to the daemon (e.g. 'qwen3.5:2b'). */
  ollamaTag: string;
  /** Human label for the boot banner. */
  label: string;
  /** Published Ollama download size in GB (NOT VRAM consumption; see docs). */
  sizeGb: number;
  /** Advertised context window. */
  contextAdvertised: string;
  /** What the vendor/independent evals market it for; unverified for this fleet. */
  strengths: readonly string[];
  /** Suggested role in this project, per the operator's workload table. */
  role: 'control' | 'trading-analysis' | 'tool-execution' | 'reasoning' | 'routing' | 'structured';
  /** Caveats an operator should know before assigning it a symbol. */
  notes?: string;
}

export const FLEET_MODEL_REGISTRY: readonly FleetModel[] = [
  {
    id: 'minicpm5-2b',
    ollamaTag: 'openbmb/minicpm5-2b:latest',
    label: 'MiniCPM5 2B',
    sizeGb: 2.0,
    contextAdvertised: '128K',
    strengths: ['lightweight coding', 'local trading analysis'],
    role: 'control',
    notes: 'Baseline control model. Vendor-reported comparisons favor it; independent JevBench (Oct 2026, one run) ranked it below Qwen3.5-2B. Keep as control until a fleet ledger says otherwise.',
  },
  {
    id: 'qwen3.5-2b',
    ollamaTag: 'qwen3.5:2b',
    label: 'Qwen 3.5 2B',
    sizeGb: 3.1,
    contextAdvertised: '256K',
    strengths: ['thinking', 'tool use', 'instruction following', 'multimodal input'],
    role: 'trading-analysis',
    notes: 'Best measured alternative on the independent JevBench comparison (69.26% vs MiniCPM5-2B 58.44%, one run). First candidate to A/B against the control on this fleet.',
  },
  {
    id: 'qwen3-4b',
    ollamaTag: 'qwen3:4b',
    label: 'Qwen 3 4B',
    sizeGb: 2.5,
    contextAdvertised: '256K',
    strengths: ['thinking', 'function calling', 'agent workflows'],
    role: 'reasoning',
    notes: 'JevBench 63.64% (one run). Heavier per-request latency than the 2B class; watch the 30s LLM timeout.',
  },
  {
    id: 'lfm2.5-2.6b',
    ollamaTag: 'LiquidAI/lfm2.5-2.6b',
    label: 'LFM2.5 2.6B',
    sizeGb: 1.7,
    contextAdvertised: '128K',
    strengths: ['native tool calling', 'agentic RL training', 'thinking'],
    role: 'tool-execution',
    notes: 'Vendor reports BFCL v4 56.88 / ToolSandbox 77.83. Vendor does not recommend it for knowledge-heavy tasks.',
  },
  {
    id: 'granite4.2-3b',
    ollamaTag: 'granite4.2:3b',
    label: 'Granite 4.2 3B',
    sizeGb: 2.2,
    contextAdvertised: '128K',
    strengths: ['native tools', 'structured JSON output', 'RAG', 'multilingual'],
    role: 'structured',
    notes: 'IBM reports BFCL v4 52.41. Strongest candidate if decision JSON parse failures become the fleet bottleneck.',
  },
  {
    id: 'nemotron3-nano-4b',
    ollamaTag: 'nemotron-3-nano:4b',
    label: 'Nemotron 3 Nano 4B',
    sizeGb: 2.9,
    contextAdvertised: '256K',
    strengths: ['thinking', 'tools', 'unified reasoning/non-reasoning'],
    role: 'reasoning',
    notes: 'No comparable independent score vs MiniCPM5-2B yet; test, do not assume.',
  },
  {
    id: 'qwen3-1.7b',
    ollamaTag: 'qwen3:1.7b',
    label: 'Qwen 3 1.7B',
    sizeGb: 1.4,
    contextAdvertised: '128K',
    strengths: ['tool selection'],
    role: 'routing',
    notes: 'Local Agent Bench (12 prompts x 20 CPU runs) reports 96% on when/which-tool decisions — a routing score, not trading-accuracy evidence.',
  },
  {
    id: 'lfm2.5-1.2b',
    ollamaTag: 'LiquidAI/lfm2.5-1.2b-instruct',
    label: 'LFM2.5 1.2B',
    sizeGb: 0.73,
    contextAdvertised: '128K',
    strengths: ['tool selection', 'tiny footprint'],
    role: 'routing',
    notes: 'Local Agent Bench reports 92% on tool-invocation decisions. Smallest candidate; useful when VRAM is the binding constraint.',
  },
] as const;

/** The control model: the fleet's default until a ledger promotes a challenger. */
export const DEFAULT_FLEET_MODEL_ID = 'minicpm5-2b';
export const DEFAULT_FLEET_MODEL_TAG = 'openbmb/minicpm5-2b:latest';
export const DEFAULT_LLM_HOST = 'http://127.0.0.1:11434';

/** Loose shape check for an Ollama model tag: 'name', 'name:tag', 'namespace/name[:tag]'. */
export function isValidOllamaTag(spec: string): boolean {
  const t = spec.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  return /^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?$/i.test(t);
}

/**
 * Resolve a model spec to a concrete Ollama tag.
 *
 *   - registry id ('qwen3.5-2b')        -> 'qwen3.5:2b'
 *   - full Ollama tag ('qwen3:4b')      -> 'qwen3:4b' (passthrough)
 *
 * Throws on an unknown registry id that is not also a valid tag shape, so a typo like
 * 'qwen35-2b' fails at boot instead of silently querying a nonexistent model.
 */
export function resolveModelTag(spec: string): string {
  const s = spec.trim();
  const hit = FLEET_MODEL_REGISTRY.find((m) => m.id === s.toLowerCase());
  if (hit) return hit.ollamaTag;
  if (isValidOllamaTag(s)) return s;
  throw new Error(`unknown fleet model '${spec}': not a registry id and not a valid Ollama tag (expected e.g. qwen3.5:2b or a registry id like qwen3.5-2b)`);
}

/** Registry metadata for a resolved tag, or undefined for passthrough tags. */
export function lookupModelByTag(ollamaTag: string): FleetModel | undefined {
  return FLEET_MODEL_REGISTRY.find((m) => m.ollamaTag === ollamaTag);
}

/** Display form: strip the owner namespace ('LiquidAI/lfm2.5-2.6b' -> 'lfm2.5-2.6b'). */
export function shortModelTag(ollamaTag: string): string {
  const slash = ollamaTag.lastIndexOf('/');
  return slash >= 0 ? ollamaTag.slice(slash + 1) : ollamaTag;
}

/** Normalize a route symbol key: 'eth' / 'ETH' / 'ETHUSDT' -> 'ETH'. */
function normalizeRouteSymbol(key: string): string {
  const k = key.trim().toUpperCase();
  return k.endsWith('USDT') ? k.slice(0, -4) : k;
}

export interface ModelRoute {
  /** Normalized base symbol ('ETH') -> resolved Ollama tag. */
  bySymbol: Record<string, string>;
}

/**
 * Parse a per-symbol model route: 'ETH=qwen3.5:2b,SOL=lfm2.5-2.6b'.
 * Keys are case-insensitive and accept an optional USDT suffix. Values go through
 * resolveModelTag, so registry ids and raw tags are both accepted. Throws on malformed pairs.
 */
export function parseModelRoute(route: string): ModelRoute {
  const bySymbol: Record<string, string> = {};
  const trimmed = route.trim();
  if (!trimmed) return { bySymbol };

  for (const pair of trimmed.split(',')) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`invalid model route pair '${pair.trim()}': expected SYMBOL=MODEL (e.g. ETH=qwen3.5:2b)`);
    const symbol = normalizeRouteSymbol(pair.slice(0, eq));
    if (!symbol) throw new Error(`invalid model route pair '${pair.trim()}': empty symbol`);
    bySymbol[symbol] = resolveModelTag(pair.slice(eq + 1));
  }
  return { bySymbol };
}

export interface FleetModelAssignment {
  /** 'ETHUSDT' -> concrete Ollama tag (default where no route override). */
  bySymbol: Record<string, string>;
  /** Distinct tags actually in use (for the boot banner). */
  distinctTags: string[];
}

/**
 * Resolve the full per-symbol assignment for the fleet: the route override when present,
 * otherwise the fleet default. Throws when a route names a symbol the fleet does not trade,
 * so a typo cannot silently strand a worker on the control model.
 */
export function resolveFleetModelAssignment(input: {
  /** Trading symbols exactly as the fleet runs them ('ETHUSDT'). */
  symbols: readonly string[];
  defaultSpec: string;
  route?: ModelRoute;
}): FleetModelAssignment {
  const defaultTag = resolveModelTag(input.defaultSpec);
  const bySymbol: Record<string, string> = {};
  const traded = new Set(input.symbols.map((s) => normalizeRouteSymbol(s)));

  for (const routed of Object.keys(input.route?.bySymbol ?? {})) {
    if (!traded.has(routed)) {
      throw new Error(`model route assigns '${routed}' but the fleet does not trade it (traded: ${[...traded].join(', ')})`);
    }
  }

  for (const symbol of input.symbols) {
    const base = normalizeRouteSymbol(symbol);
    bySymbol[symbol] = input.route?.bySymbol[base] ?? defaultTag;
  }

  return { bySymbol, distinctTags: [...new Set(Object.values(bySymbol))] };
}

/** Per-request timeout suggestion: thinking-capable models get a wider budget on modest GPUs. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
export const THINKING_MODEL_TIMEOUT_MS = 60_000;
