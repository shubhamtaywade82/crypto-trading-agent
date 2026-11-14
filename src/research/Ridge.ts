/** Ridge regression on standardised, winsorised features: small, closed-form and readable, so every coefficient can be inspected. */
export interface RidgeModel { mean: number[]; std: number[]; coefficients: number[]; intercept: number }

const WINSOR = 5;

function standardise(row: readonly number[], mean: readonly number[], std: readonly number[]): number[] {
  return row.map((v, j) => Math.max(-WINSOR, Math.min(WINSOR, (v - mean[j]!) / std[j]!)));
}

/** Solves A x = b by Gaussian elimination with partial pivoting (A is symmetric positive definite here). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!]; [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    for (let r = col + 1; r < n; r += 1) {
      const factor = a[r]![col]! / a[col]![col]!;
      for (let c = col; c < n; c += 1) a[r]![c]! -= factor * a[col]![c]!;
      b[r]! -= factor * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = b[r]!;
    for (let c = r + 1; c < n; c += 1) sum -= a[r]![c]! * x[c]!;
    x[r] = sum / a[r]![r]!;
  }
  return x;
}

export function fitRidge(x: readonly (readonly number[])[], y: readonly number[], lambda: number): RidgeModel {
  const d = x[0]!.length; const n = x.length;
  const mean = Array.from({ length: d }, (_, j) => x.reduce((s, row) => s + row[j]!, 0) / n);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(x.reduce((s, row) => s + (row[j]! - mean[j]!) ** 2, 0) / n) || 1);
  const intercept = y.reduce((s, v) => s + v, 0) / n;
  const gram = Array.from({ length: d }, () => new Array<number>(d).fill(0)); const target = new Array<number>(d).fill(0);
  x.forEach((row, i) => {
    const z = standardise(row, mean, std);
    for (let a = 0; a < d; a += 1) { target[a]! += z[a]! * (y[i]! - intercept); for (let b = a; b < d; b += 1) gram[a]![b]! += z[a]! * z[b]!; }
  });
  for (let a = 0; a < d; a += 1) { gram[a]![a]! += lambda; for (let b = 0; b < a; b += 1) gram[a]![b] = gram[b]![a]!; }
  return { mean, std, coefficients: solve(gram, target), intercept };
}

export function predictRidge(model: RidgeModel, row: readonly number[]): number {
  const z = standardise(row, model.mean, model.std);
  return model.intercept + z.reduce((s, v, j) => s + v * model.coefficients[j]!, 0);
}
