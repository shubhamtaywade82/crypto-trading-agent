import { mulberry32 } from './Bootstrap.js';

/**
 * Small gradient-boosted regression trees with histogram splits: squared loss, depth-limited, quantile-binned features.
 * Fixed hyper-parameters are chosen in the spec before any data is read; there is no tuning inside this module.
 */
export interface GbtParams { rounds: number; depth: number; learningRate: number; subsample: number; bins: number; minLeaf: number; seed: number }
export const DEFAULT_GBT: GbtParams = { rounds: 150, depth: 3, learningRate: 0.05, subsample: 0.5, bins: 32, minLeaf: 200, seed: 1 };

interface Node { feature: number; bin: number; left: Node | number; right: Node | number } // a number child is a leaf value
export interface GbtModel { edges: number[][]; base: number; learningRate: number; trees: (Node | number)[] }

function quantileEdges(x: readonly (readonly number[])[], feature: number, bins: number): number[] {
  const sorted = x.map((row) => row[feature]!).sort((a, b) => a - b);
  const edges: number[] = [];
  for (let b = 1; b < bins; b += 1) { const e = sorted[Math.floor((b * sorted.length) / bins)]!; if (edges.length === 0 || e > edges[edges.length - 1]!) edges.push(e); }
  return edges;
}

function binOf(value: number, edges: readonly number[]): number {
  let lo = 0; let hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (value < edges[mid]!) hi = mid; else lo = mid + 1; }
  return lo;
}

interface Split { feature: number; bin: number; gain: number }

function bestSplit(binned: Uint8Array[], residual: Float64Array, rows: Int32Array, bins: number, minLeaf: number): Split | null {
  let best: Split | null = null;
  const total = rows.reduce((s, r) => s + residual[r]!, 0);
  for (let f = 0; f < binned.length; f += 1) {
    const sum = new Float64Array(bins); const count = new Int32Array(bins);
    for (const r of rows) { const b = binned[f]![r]!; sum[b]! += residual[r]!; count[b]! += 1; }
    let leftSum = 0; let leftCount = 0;
    for (let b = 0; b < bins - 1; b += 1) {
      leftSum += sum[b]!; leftCount += count[b]!;
      const rightCount = rows.length - leftCount;
      if (leftCount < minLeaf || rightCount < minLeaf) continue;
      const gain = (leftSum * leftSum) / leftCount + ((total - leftSum) ** 2) / rightCount - (total * total) / rows.length;
      if (!best || gain > best.gain) best = { feature: f, bin: b, gain };
    }
  }
  return best && best.gain > 0 ? best : null;
}

function grow(binned: Uint8Array[], residual: Float64Array, rows: Int32Array, depth: number, p: GbtParams): Node | number {
  const mean = rows.length ? rows.reduce((s, r) => s + residual[r]!, 0) / rows.length : 0;
  const split = depth > 0 ? bestSplit(binned, residual, rows, p.bins, p.minLeaf) : null;
  if (!split) return mean;
  const left = rows.filter((r) => binned[split.feature]![r]! <= split.bin); const right = rows.filter((r) => binned[split.feature]![r]! > split.bin);
  return { feature: split.feature, bin: split.bin, left: grow(binned, residual, left, depth - 1, p), right: grow(binned, residual, right, depth - 1, p) };
}

function walk(tree: Node | number, bin: (feature: number) => number): number {
  return typeof tree === 'number' ? tree : walk(bin(tree.feature) <= tree.bin ? tree.left : tree.right, bin);
}

export function fitGbt(x: readonly (readonly number[])[], y: readonly number[], params: GbtParams = DEFAULT_GBT): GbtModel {
  const d = x[0]!.length; const n = x.length; const rand = mulberry32(params.seed);
  const edges = Array.from({ length: d }, (_, f) => quantileEdges(x, f, params.bins));
  const binned = Array.from({ length: d }, (_, f) => Uint8Array.from(x, (row) => binOf(row[f]!, edges[f]!)));
  const base = y.reduce((s, v) => s + v, 0) / n;
  const fitted = new Float64Array(n).fill(base); const residual = new Float64Array(n); const trees: (Node | number)[] = [];
  for (let round = 0; round < params.rounds; round += 1) {
    for (let i = 0; i < n; i += 1) residual[i] = y[i]! - fitted[i]!;
    const sample = Int32Array.from({ length: n }, (_, i) => i).filter(() => rand() < params.subsample);
    const tree = grow(binned, residual, sample, params.depth, params);
    trees.push(tree);
    for (let i = 0; i < n; i += 1) fitted[i]! += params.learningRate * walk(tree, (f) => binned[f]![i]!);
  }
  return { edges, base, learningRate: params.learningRate, trees };
}

export function predictGbt(model: GbtModel, row: readonly number[]): number {
  const bins = row.map((v, f) => binOf(v, model.edges[f]!));
  return model.base + model.trees.reduce<number>((s, tree) => s + model.learningRate * walk(tree, (f) => bins[f]!), 0);
}
