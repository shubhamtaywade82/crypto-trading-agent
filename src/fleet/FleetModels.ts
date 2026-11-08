/**
 * Fleet model registry: the Ollama Cloud models the LLM fleet can assign per symbol, plus the
 * resolution/parsing helpers that map CLI/env specs to concrete model tags.
 *
 * Design stance (docs/LLM_TRADING_FLEET.md "Model Selection"):
 *   1. The registry is the Ollama Cloud free tier (2026-11). beam is the default because it is
 *      free and preferred by the operator. Vendor benchmarks are not evidence this fleet trades
 *      better on another model: a challenger earns nothing until its own fleet ledger clears the
 *      promotion gates (npm run self-improve; docs/RESEARCH_SYSTEM.md).
 *   2. Any valid Ollama tag is accepted, registry or not. The registry adds metadata for the boot
 *      banner and docs; it never restricts choice.
 */

/** A registry entry. `id` is the stable key used by --model/--route. */
export interface FleetModel {
  /** Stable short id accepted by --model and --route (e.g. 'gpt-oss-20b'). */
  id: string;
  /** Exact Ollama tag to send (e.g. 'gpt-oss:20b'). */
  ollamaTag: string;
  /** Human label for the boot banner. */
  label: string;
  /** What the vendor markets it for; unverified for this fleet. */
  strengths: readonly string[];
  /** Suggested role in this project. */
  role: 'control' | 'trading-analysis' | 'reasoning' | 'structured';
  /** Caveats an operator should know before assigning it a symbol. */
  notes?: string;
}

export const FLEET_MODEL_REGISTRY: readonly FleetModel[] = [
  { id: 'beam', ollamaTag: 'beam', label: 'Beam', strengths: ['thinking', 'instruction following'], role: 'control', notes: 'Default: free on Ollama Cloud and preferred by the operator.' },
  { id: 'gemma4-31b', ollamaTag: 'gemma4:31b', label: 'Gemma 4 31B', strengths: ['structured output', 'instruction following'], role: 'structured' },
  { id: 'gpt-oss-120b', ollamaTag: 'gpt-oss:120b', label: 'GPT-OSS 120B', strengths: ['reasoning', 'tool use'], role: 'reasoning', notes: 'Largest free model; slowest per request.' },
  { id: 'gpt-oss-20b', ollamaTag: 'gpt-oss:20b', label: 'GPT-OSS 20B', strengths: ['reasoning', 'tool use'], role: 'trading-analysis' },
  { id: 'nemotron-3-nano-30b', ollamaTag: 'nemotron-3-nano:30b', label: 'Nemotron 3 Nano 30B', strengths: ['thinking', 'tools'], role: 'trading-analysis' },
  { id: 'nemotron-3-super', ollamaTag: 'nemotron-3-super', label: 'Nemotron 3 Super', strengths: ['thinking', 'tools'], role: 'reasoning' },
  { id: 'nemotron-3-ultra', ollamaTag: 'nemotron-3-ultra', label: 'Nemotron 3 Ultra', strengths: ['thinking', 'tools'], role: 'reasoning' },
] as const;

/** The control model: the fleet's default until a ledger promotes a challenger. */
export const DEFAULT_FLEET_MODEL_ID = 'beam';
export const DEFAULT_FLEET_MODEL_TAG = 'beam';
export const DEFAULT_LLM_HOST = 'https://ollama.com';

/** Loose shape check for an Ollama model tag: 'name', 'name:tag', 'namespace/name[:tag]'. */
export function isValidOllamaTag(spec: string): boolean {
  const t = spec.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  return /^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?$/i.test(t);
}

/**
 * Resolve a model spec to a concrete Ollama tag.
 *
 *   - registry id ('gpt-oss-20b')       -> 'gpt-oss:20b'
 *   - full Ollama tag ('gemma4:31b')    -> 'gemma4:31b' (passthrough)
 *
 * Throws on an unknown registry id that is not also a valid tag shape, so a typo like
 * 'gpt-oss20b' fails at boot instead of silently querying a nonexistent model.
 */
export function resolveModelTag(spec: string): string {
  const s = spec.trim();
  const hit = FLEET_MODEL_REGISTRY.find((m) => m.id === s.toLowerCase());
  if (hit) return hit.ollamaTag;
  if (isValidOllamaTag(s)) return s;
  throw new Error(`unknown fleet model '${spec}': not a registry id and not a valid Ollama tag (expected e.g. gpt-oss:20b or a registry id like gpt-oss-20b)`);
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
