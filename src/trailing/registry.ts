import type { MethodId, MethodLayer, MethodPriority, PolicyDomain, PriceReference, TrailingPolicy } from './types.js';

/**
 * Versioned policy registry (spec §7). Closed world on purpose: an unknown method id or a param
 * outside its research grid is refused at load — mirrors the HypothesisRegistry whitelist doctrine.
 * Phase-1 methods only; later phases extend METHOD_SPECS (the schema, not this array's semantics).
 */

interface MethodSpec {
  layer: MethodLayer;
  domain: PolicyDomain;
  priority: MethodPriority;
  priceReference: PriceReference;
  defaults: Record<string, number | string>;
  allowed: Record<string, readonly (number | string)[]>;
}

const TF_GRID: readonly string[] = ['5m', '15m', '1h'];

const METHOD_SPECS: Partial<Record<MethodId, MethodSpec>> = {
  ATR_TRAIL: {
    layer: 'PRICE', domain: 'CONTRACT', priority: 'P0', priceReference: 'CONTRACT_PRICE',
    defaults: { period: 14, k: 2, tf: '15m' },
    allowed: { period: [7, 14, 21], k: [1.5, 2, 2.5, 3], tf: TF_GRID },
  },
  CHANDELIER: {
    layer: 'PRICE', domain: 'CONTRACT', priority: 'P0', priceReference: 'CONTRACT_PRICE',
    defaults: { n: 22, k: 3, tf: '15m' },
    allowed: { n: [14, 22, 55], k: [2, 2.5, 3, 3.5], tf: TF_GRID },
  },
  SWING: {
    layer: 'PRICE', domain: 'CONTRACT', priority: 'P0', priceReference: 'CONTRACT_PRICE',
    defaults: { nLeft: 3, nRight: 2, bufferAtr: 0.1, bufferTicks: 2, tf: '15m' },
    allowed: { nLeft: [3], nRight: [2], bufferAtr: [0.1, 0.2, 0.3], bufferTicks: [0, 1, 2], tf: TF_GRID },
  },
  BOS_CHOCH: {
    layer: 'PRICE', domain: 'CONTRACT', priority: 'P0', priceReference: 'CONTRACT_PRICE',
    defaults: { nLeft: 3, nRight: 2, bufferAtr: 0.2, tf: '15m' },
    allowed: { nLeft: [3, 5], nRight: [2, 3], bufferAtr: [0.1, 0.2, 0.3], tf: TF_GRID },
  },
};

export const PHASE1_METHODS: readonly MethodId[] = ['ATR_TRAIL', 'CHANDELIER', 'SWING', 'BOS_CHOCH'];

interface BuildOptions {
  readonly version?: string;
  readonly enabled?: boolean;
  readonly activation?: { type: TrailingPolicy['activation']['type']; threshold: number };
}

/** Builds a policy instance; throws on an unknown method or an out-of-grid param (fail loud). */
export function buildPolicy(id: string, method: MethodId, params: Record<string, number | string>, opts: BuildOptions = {}): TrailingPolicy {
  const spec = METHOD_SPECS[method];
  if (!spec) throw new Error(`unknown trailing method: ${method}`);
  const merged: Record<string, number | string> = { ...spec.defaults, ...params };
  const errors = validateParams(method, merged);
  if (errors.length > 0) throw new Error(`policy ${id}: ${errors.join('; ')}`);
  return {
    id, version: opts.version ?? '1', method,
    layer: spec.layer, domain: spec.domain, priority: spec.priority,
    params: merged,
    activation: opts.activation ?? { type: 'IMMEDIATE', threshold: 0 },
    priceReference: spec.priceReference,
    enabled: opts.enabled ?? true,
  };
}

/** Validates a whole policy object (shape, closed-world method, grid values, field agreement). */
export function validatePolicy(policy: TrailingPolicy): string[] {
  const errors: string[] = [];
  const spec = METHOD_SPECS[policy.method];
  if (!spec) return [`unknown method: ${policy.method}`];
  if (typeof policy.id !== 'string' || policy.id.length === 0) errors.push('id required');
  if (policy.layer !== spec.layer || policy.domain !== spec.domain || policy.priority !== spec.priority
    || policy.priceReference !== spec.priceReference) return [...errors, 'field disagreement with method spec'];
  errors.push(...validateParams(policy.method, policy.params));
  if (!Number.isFinite(policy.activation.threshold)) errors.push('activation threshold not finite');
  if (typeof policy.enabled !== 'boolean') errors.push('enabled not boolean');
  return errors;
}

function validateParams(method: MethodId, params: Record<string, number | string>): string[] {
  const spec = METHOD_SPECS[method];
  if (!spec) return [`unknown method: ${method}`];
  const errors: string[] = [];
  for (const key of Object.keys(params)) {
    if (!(key in spec.defaults)) { errors.push(`unknown param ${key}`); continue; }
    const value = params[key];
    const grid = spec.allowed[key];
    if (grid !== undefined && !grid.includes(value)) {
      errors.push(`param ${key}=${String(value)} outside research grid [${grid.map(String).join(', ')}]`);
    }
  }
  for (const key of Object.keys(spec.defaults)) {
    if (!(key in params)) errors.push(`missing param ${key}`);
  }
  return errors;
}
