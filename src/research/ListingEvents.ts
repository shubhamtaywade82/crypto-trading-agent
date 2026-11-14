/**
 * Single-contract event trades hedged with BTC (docs/NEMESIS_G4_STRATEGY_SPECS.md §14 listings, §18 extreme days).
 * Entry at a daily open, exit `hold` days later, costs on both legs, funding on both legs.
 */
import { DAY_MS, exitPrice, fundingSum, mean30Volume, MIN_HISTORY_DAYS, MIN_QUOTE_VOLUME, SIDE_COST_RATE, universeAt, type Panel } from './CrossSection.js';

export interface ListingEvent { symbol: number; time: number; dir: 1 | -1; ret: number; funding: number; btcRet: number; btcFunding: number; peers: { ret: number[]; funding: number[] } }
export const LISTING_ROUND_TRIP_COST = 4 * SIDE_COST_RATE; // short leg and BTC hedge leg, in and out

/** Hedged short of each new listing: entry at the open of day L+delay, exit `hold` days later (§14). */
export function listingEvents(panel: Panel, btc: number, delay: number, hold: number, from: number, to: number): ListingEvent[] {
  const events: ListingEvent[] = [];
  panel.data.forEach((d, s) => {
    const listed = d.close.findIndex((v) => Number.isFinite(v));
    const m = listed + delay;
    const time = panel.start + m * DAY_MS;
    if (listed < 60 || time < from || time > to || m + hold >= panel.days || !Number.isFinite(d.open[m]!)) return;
    const move = (k: number): { ret: number; funding: number } => ({ ret: exitPrice(panel.data[k]!, m, hold) / panel.data[k]!.open[m]! - 1, funding: fundingSum(panel.funding[k]!, time, time + hold * DAY_MS) });
    const alt = move(s);
    if (!Number.isFinite(alt.ret)) return;
    const peers = universeAt(panel, m, Infinity).filter((k) => k !== s && Number.isFinite(move(k).ret)).map(move);
    events.push({ symbol: s, time, dir: -1, ret: alt.ret, funding: alt.funding, btcRet: move(btc).ret, btcFunding: move(btc).funding, peers: { ret: peers.map((p) => p.ret), funding: peers.map((p) => p.funding) } });
  });
  return events.sort((a, b) => a.time - b.time);
}

/** Excess return of the event trade (`dir` -1 = short the symbol against a BTC long, +1 = long it against a BTC short). */
export const listingNet = (e: ListingEvent, costScale = 1): number => e.dir * (e.ret - e.btcRet) - e.dir * (e.funding - e.btcFunding) - costScale * LISTING_ROUND_TRIP_COST;

/** Mean cost-free hedged return of shorting one random eligible peer per event instead of the listing. */
export function randomPeerMeans(events: readonly ListingEvent[], n: number, random: () => number): number[] {
  const usable = events.filter((e) => e.peers.ret.length > 0);
  return Array.from({ length: n }, () => {
    const total = usable.reduce((sum, e) => {
      const i = Math.floor(random() * e.peers.ret.length);
      return sum + e.dir * (e.peers.ret[i]! - e.btcRet) - e.dir * (e.peers.funding[i]! - e.btcFunding);
    }, 0);
    return total / usable.length;
  });
}

export interface MoveEventRule { dir: 1 | -1; dayReturn: number; hold: number; from: number; to: number }

/** Symbols that closed a day beyond the threshold (up for dir -1, down for dir +1), entered at the next open; one open trade per symbol. */
export function moveEvents(panel: Panel, btc: number, rule: MoveEventRule): ListingEvent[] {
  const events: ListingEvent[] = [];
  panel.data.forEach((d, s) => {
    let busyUntil = -1;
    for (let m = 91; m + rule.hold < panel.days; m += 1) {
      const time = panel.start + m * DAY_MS;
      const move = d.close[m - 1]! / d.close[m - 2]! - 1;
      const triggered = rule.dir === -1 ? move >= rule.dayReturn : move <= -rule.dayReturn;
      if (m <= busyUntil || time < rule.from || time > rule.to || !triggered || !Number.isFinite(d.open[m]!)) continue;
      if (!(mean30Volume(d, m) >= MIN_QUOTE_VOLUME) || !Number.isFinite(d.close[m - MIN_HISTORY_DAYS]!)) continue;
      events.push(buildEvent(panel, btc, s, m, rule));
      busyUntil = m + rule.hold;
    }
  });
  return events.filter((e) => Number.isFinite(e.ret)).sort((a, b) => a.time - b.time);
}

function buildEvent(panel: Panel, btc: number, s: number, m: number, rule: MoveEventRule): ListingEvent {
  const time = panel.start + m * DAY_MS;
  const span = (k: number): { ret: number; funding: number } => ({ ret: exitPrice(panel.data[k]!, m, rule.hold) / panel.data[k]!.open[m]! - 1, funding: fundingSum(panel.funding[k]!, time, time + rule.hold * DAY_MS) });
  const peers = universeAt(panel, m, Infinity).filter((k) => k !== s && Number.isFinite(span(k).ret)).map(span);
  const alt = span(s);
  return { symbol: s, time, dir: rule.dir, ret: alt.ret, funding: alt.funding, btcRet: span(btc).ret, btcFunding: span(btc).funding, peers: { ret: peers.map((p) => p.ret), funding: peers.map((p) => p.funding) } };
}
