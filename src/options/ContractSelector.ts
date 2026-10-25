import { blackScholes } from './blackScholes.js';
import { bestAsk, bestBid, optionFee, type FeeModel } from './execution.js';
import type { MarkSnapshot } from './OptionChainService.js';
import type { Greeks, IndexQuote, OptionContract, OptionQuote, OptionRight } from './types.js';

export interface SelectionLimits {
  minDteHours: number;
  maxDteHours: number;
  targetDelta: number;
  minDelta: number;
  maxDelta: number;
  maxSpreadPct: number;
  maxIvRv: number;
  modelTolerance: number;
  allowedUnits: number[];
  depthCandidates: number;
  quoteStaleMs: number;
  indexStaleMs: number;
}

export interface EconomicsLimits {
  holdHorizonHours: number;
  minEdgeRatio: number;
  minRewardRisk: number;
  stopPct: number;
  targetPct: number;
}

/** A contract that passed the mark-level screen: right, expiry window, unit, model consistency and delta band. */
export interface ScreenedContract {
  contract: OptionContract;
  mark: MarkSnapshot;
  greeks: Greeks;
}

export interface EntryEconomics {
  ask: number;
  bid: number;
  spreadPct: number;
  /** 1h ATR scaled to the hold horizon: the move the trade is underwritten for. A heuristic, not a forecast. */
  expectedMove: number;
  /** Premium gain per contract from that move: |delta| x move + gamma x move^2 / 2, times the contract unit. */
  expectedGain: number;
  /** Spread crossed twice plus round-trip fees, per contract. */
  roundTripCost: number;
  /** Theta over the hold horizon, per contract. */
  decayCost: number;
  /** expectedGain / (roundTripCost + decayCost). */
  edgeRatio: number;
  /** Underlying move, % of spot, the delta needs just to pay the round-trip cost back. */
  breakevenMovePct: number;
  stopPremium: number;
  targetPremium: number;
  rewardRisk: number;
  ivRvRatio: number;
}

export interface Selection {
  screened: ScreenedContract;
  quote: OptionQuote;
  economics: EntryEconomics;
}

export type SelectionResult = { ok: true; selection: Selection } | { ok: false; reasons: string[] };

const HOUR_MS = 3_600_000;

/** Step 1, marks only: no depth request is spent on a contract that fails here. Best candidates first. */
export function screenContracts(params: {
  contracts: ReadonlyArray<OptionContract>;
  marks: ReadonlyMap<string, MarkSnapshot>;
  index: IndexQuote;
  right: OptionRight;
  now: number;
  limits: SelectionLimits;
}): { candidates: ScreenedContract[]; rejected: Record<string, number> } {
  const { contracts, marks, index, right, now, limits } = params;
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
  const candidates: ScreenedContract[] = [];

  for (const contract of contracts) {
    if (contract.right !== right) continue;
    const hours = (contract.expiryMs - now) / HOUR_MS;
    if (hours < limits.minDteHours || hours > limits.maxDteHours) { reject('expiry outside DTE window'); continue; }
    if (!limits.allowedUnits.includes(contract.unit)) { reject(`contract unit ${contract.unit} not verified`); continue; }
    const mark = marks.get(contract.symbol);
    if (!mark) { reject('no mark'); continue; }
    if (mark.markIv === null) { reject('no mark IV'); continue; }
    const greeks = blackScholes({ right, spot: index.price, strike: contract.strike, timeToExpiryMs: contract.expiryMs - now, vol: mark.markIv, rate: mark.riskFreeRate });
    if (!greeks || !(greeks.price > 0)) { reject('model cannot price'); continue; }
    // The venue's mark should be the model price at the venue's own IV. A large gap means the premium, the IV or the
    // contract scale is not what this code assumes (e.g. a premium quoted per multi-unit contract), so it is refused.
    const gap = Math.abs(mark.mark - greeks.price);
    if (gap > Math.max(limits.modelTolerance * greeks.price, 5 * contract.tickSize)) { reject('mark disagrees with model'); continue; }
    const absDelta = Math.abs(greeks.delta);
    if (absDelta < limits.minDelta || absDelta > limits.maxDelta) { reject('delta outside band'); continue; }
    candidates.push({ contract, mark, greeks });
  }

  candidates.sort((a, b) =>
    Math.abs(Math.abs(a.greeks.delta) - limits.targetDelta) - Math.abs(Math.abs(b.greeks.delta) - limits.targetDelta)
    || a.contract.expiryMs - b.contract.expiryMs);
  return { candidates, rejected };
}

/** Step 2, with an executable book: spread, freshness, IV vs realized vol and the cost/edge/reward:risk gates. */
export function evaluateEconomics(params: {
  screened: ScreenedContract;
  quote: OptionQuote;
  index: IndexQuote;
  realizedVol: number;
  atr1h: number;
  now: number;
  selection: SelectionLimits;
  economics: EconomicsLimits;
  fees: FeeModel;
}): { ok: true; economics: EntryEconomics } | { ok: false; reason: string } {
  const { screened, quote, index, realizedVol, atr1h, now, selection, economics, fees } = params;
  const { contract, greeks, mark } = screened;
  if (now - quote.receivedAt > selection.quoteStaleMs) return { ok: false, reason: `quote stale (${now - quote.receivedAt}ms)` };
  if (now - index.receivedAt > selection.indexStaleMs) return { ok: false, reason: `index stale (${now - index.receivedAt}ms)` };
  const ask = bestAsk(quote.asks);
  const bid = bestBid(quote.bids);
  if (ask === null || bid === null) return { ok: false, reason: 'one-sided book' };
  if (bid >= ask) return { ok: false, reason: `crossed book (bid ${bid} >= ask ${ask})` };
  const mid = (ask + bid) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;
  if (spreadPct > selection.maxSpreadPct) return { ok: false, reason: `spread ${spreadPct.toFixed(2)}% above ${selection.maxSpreadPct}%` };

  const ivRvRatio = (mark.markIv as number) / realizedVol;
  if (ivRvRatio > selection.maxIvRv) return { ok: false, reason: `IV/RV ${ivRvRatio.toFixed(2)} above ${selection.maxIvRv}` };

  const unit = contract.unit;
  const expectedMove = atr1h * Math.sqrt(economics.holdHorizonHours);
  const expectedGain = (Math.abs(greeks.delta) * expectedMove + 0.5 * greeks.gamma * expectedMove ** 2) * unit;
  const feePerContract = optionFee(fees, ask, 1, index.price, unit) + optionFee(fees, bid, 1, index.price, unit);
  const roundTripCost = (ask - bid) + feePerContract;
  const decayCost = Math.abs(greeks.thetaPerDay) * (economics.holdHorizonHours / 24) * unit;
  const edgeRatio = expectedGain / (roundTripCost + decayCost);
  const breakevenMovePct = (roundTripCost / (Math.abs(greeks.delta) * unit) / index.price) * 100;
  const stopPremium = ask * (1 - economics.stopPct / 100);
  const targetPremium = ask * (1 + economics.targetPct / 100);
  const rewardRisk = (targetPremium - ask) / (ask - stopPremium);

  const result: EntryEconomics = {
    ask, bid, spreadPct, expectedMove, expectedGain, roundTripCost, decayCost, edgeRatio, breakevenMovePct,
    stopPremium, targetPremium, rewardRisk, ivRvRatio,
  };
  if (!(edgeRatio >= economics.minEdgeRatio)) return { ok: false, reason: `edge ratio ${edgeRatio.toFixed(2)} below ${economics.minEdgeRatio}` };
  if (!(rewardRisk >= economics.minRewardRisk)) return { ok: false, reason: `reward:risk ${rewardRisk.toFixed(2)} below ${economics.minRewardRisk}` };
  return { ok: true, economics: result };
}

/** Screens on marks, then pays for depth only on the best `depthCandidates`, returning the first that passes the economics gate. */
export async function selectContract(params: {
  contracts: ReadonlyArray<OptionContract>;
  marks: ReadonlyMap<string, MarkSnapshot>;
  index: IndexQuote;
  right: OptionRight;
  realizedVol: number;
  atr1h: number;
  now: () => number;
  selection: SelectionLimits;
  economics: EconomicsLimits;
  fees: FeeModel;
  fetchQuote: (symbol: string, mark: MarkSnapshot) => Promise<OptionQuote>;
}): Promise<SelectionResult> {
  const { candidates, rejected } = screenContracts({ ...params, now: params.now(), limits: params.selection });
  const reasons = Object.entries(rejected).map(([why, n]) => `${n}x ${why}`);
  if (candidates.length === 0) return { ok: false, reasons: reasons.length > 0 ? reasons : ['no listed contract for this side'] };

  for (const screened of candidates.slice(0, params.selection.depthCandidates)) {
    const quote = await params.fetchQuote(screened.contract.symbol, screened.mark);
    const verdict = evaluateEconomics({ ...params, screened, quote, now: params.now() });
    if (verdict.ok) return { ok: true, selection: { screened, quote, economics: verdict.economics } };
    reasons.push(`${screened.contract.symbol}: ${verdict.reason}`);
  }
  return { ok: false, reasons };
}
