import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSniperEligible,
  createSniperPosition,
  evaluatePositionTick,
  formatSniperCard,
  fetchSmartMoneySignals,
  type SmartMoneySignal,
} from '../src/execution/SmartMoneySniper.js';

const mockSignal: SmartMoneySignal = {
  signalId: 101,
  ticker: 'TESTPUMP',
  chainId: 'CT_501',
  contractAddress: 'So11111111111111111111111111111111111111112',
  launchPlatform: 'Pumpfun',
  smartSignalType: 'SMART_MONEY',
  smartMoneyCount: 4,
  direction: 'buy',
  alertPrice: '0.00100000',
  currentPrice: '0.00100000',
  exitRate: 15,
  status: 'valid',
  signalTriggerTime: Date.now(),
  tokenTag: {
    'Social Events': [{ tagName: 'DEX Paid' }],
  },
};

describe('SmartMoneySniper', () => {
  it('approves eligible signals on Pumpfun or DEX Paid with low exit rate', () => {
    assert.equal(isSniperEligible(mockSignal), true);
  });

  it('rejects signals with high exit rate or non-buy direction', () => {
    const highExit = { ...mockSignal, exitRate: 50 };
    assert.equal(isSniperEligible(highExit), false);

    const sellDir = { ...mockSignal, direction: 'sell' };
    assert.equal(isSniperEligible(sellDir), false);
  });

  it('rejects stale statuses and high-tax traps', () => {
    const stale = { ...mockSignal, status: 'timeout' };
    assert.equal(isSniperEligible(stale), false);

    const highTax: SmartMoneySignal = {
      ...mockSignal,
      tokenTag: { 'Risk': [{ tagName: 'High Tax Token' }] },
    };
    assert.equal(isSniperEligible(highTax), false);
  });

  it('creates sniper position with exact +20% TP and -10% SL limits', () => {
    const baseTime = 1_000_000;
    const pos = createSniperPosition(mockSignal, undefined, baseTime);

    assert.equal(pos.entryPrice, 0.001);
    assert.equal(pos.targetPrice, 0.0012);
    assert.equal(pos.stopPrice, 0.0009);
    assert.equal(pos.expiryTimeMs, baseTime + 15 * 60 * 1000);
    assert.equal(pos.status, 'OPEN');
  });

  it('resolves TP_HIT when price crosses target', () => {
    const pos = createSniperPosition(mockSignal, undefined, 1_000_000);
    const tick = evaluatePositionTick(pos, 0.00125, 1_000_100);

    assert.equal(tick.status, 'TP_HIT');
    assert.equal(tick.exitPrice, 0.0012);
    assert.equal(tick.realizedPnlUsd, 40); // 20% on $200
  });

  it('resolves SL_HIT when price crosses stop loss', () => {
    const pos = createSniperPosition(mockSignal, undefined, 1_000_000);
    const tick = evaluatePositionTick(pos, 0.00085, 1_000_100);

    assert.equal(tick.status, 'SL_HIT');
    assert.equal(tick.exitPrice, 0.0009);
    assert.equal(tick.realizedPnlUsd, -20); // -10% on $200
  });

  it('resolves EXPIRED when 15-minute window elapses', () => {
    const baseTime = 1_000_000;
    const pos = createSniperPosition(mockSignal, undefined, baseTime);
    const tick = evaluatePositionTick(pos, 0.00105, baseTime + 16 * 60 * 1000);

    assert.equal(tick.status, 'EXPIRED');
    assert.equal(tick.exitPrice, 0.00105);
    assert.equal(tick.realizedPnlUsd, 10); // +5% on $200
  });

  it('formats Telegram card with valid HTML markup and DexScreener link', () => {
    const pos = createSniperPosition(mockSignal, undefined, 1_000_000);
    const card = formatSniperCard(mockSignal, pos);

    assert.match(card, /SMART MONEY SNIPER ALERT/);
    assert.match(card, /TESTPUMP/);
    assert.match(card, /Target \(\+20%\):/);
    assert.match(card, /dexscreener\.com\/solana\//);
  });

  it('fetches and deserializes signals via custom fetch dependency', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockSignal] }), { status: 200 });

    const signals = await fetchSmartMoneySignals('CT_501', 1, mockFetch as unknown as typeof fetch);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].ticker, 'TESTPUMP');
  });
});
