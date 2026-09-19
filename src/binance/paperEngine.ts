import type { Position } from '../types.js';

interface PaperPosition extends Position {
  orderId: string;
}

const initialPaperPositions: PaperPosition[] = [
  {
    id: 'ETH_HEDGE',
    orderId: '1001',
    symbol: 'ETH/USDT',
    side: 'SHORT',
    strategy: 'FUNDING-ARB-α',
    entry: 2630.0,
    qty: 2.0,
    mark: 2626.2,
    upnl: 7.6,
    upnlPct: 0.14,
    leverage: 1,
    marginType: 'ISOLATED',
    liqDistancePct: null,
    serverSl: '—',
    serverTp: 'fund',
    posType: 'SPOT+SHORT',
  },
  {
    id: 'SOL_HEDGE',
    orderId: '1002',
    symbol: 'SOL/USDT',
    side: 'SHORT',
    strategy: 'FUNDING-ARB-α',
    entry: 112.2,
    qty: 30.0,
    mark: 111.6,
    upnl: 18.0,
    upnlPct: 0.53,
    leverage: 1,
    marginType: 'ISOLATED',
    liqDistancePct: null,
    serverSl: '—',
    serverTp: 'fund',
    posType: 'SPOT+SHORT',
  },
  {
    id: 'BTC_ETH_PAIR',
    orderId: '1003',
    symbol: 'BTC/ETH',
    side: 'LONG',
    strategy: 'PAIRS-TRD-β',
    entry: 30.75,
    qty: 0.5,
    mark: 30.87,
    upnl: 60.0,
    upnlPct: 0.39,
    leverage: 2,
    marginType: 'ISOLATED',
    liqDistancePct: 14.2,
    serverSl: '29.5',
    serverTp: '32.0',
    posType: 'LONG/SHORT',
  },
  {
    id: 'SOL_AVAX_PAIR',
    orderId: '1004',
    symbol: 'SOL/AVAX',
    side: 'LONG',
    strategy: 'PAIRS-TRD-β',
    entry: 13.02,
    qty: 20.0,
    mark: 13.08,
    upnl: 12.0,
    upnlPct: 0.46,
    leverage: 2,
    marginType: 'ISOLATED',
    liqDistancePct: 12.8,
    serverSl: '12.4',
    serverTp: '13.8',
    posType: 'LONG/SHORT',
  },
  {
    id: 'BTC_MOM',
    orderId: '1005',
    symbol: 'BTC/USDT',
    side: 'LONG',
    strategy: 'MOMENTUM-γ',
    entry: 80950.0,
    qty: 0.3,
    mark: 81070.0,
    upnl: 36.0,
    upnlPct: 0.15,
    leverage: 3,
    marginType: 'ISOLATED',
    liqDistancePct: 18.7,
    serverSl: '79500',
    serverTp: '83500',
    posType: 'LONG',
  },
  {
    id: 'AVAX_MOM',
    orderId: '1006',
    symbol: 'AVAX/USDT',
    side: 'LONG',
    strategy: 'MOMENTUM-γ',
    entry: 8.48,
    qty: 100.0,
    mark: 8.54,
    upnl: 6.0,
    upnlPct: 0.71,
    leverage: 3,
    marginType: 'ISOLATED',
    liqDistancePct: 16.4,
    serverSl: '8.10',
    serverTp: '9.20',
    posType: 'LONG',
  },
];

export class PaperEngine {
  private positions: PaperPosition[] = [...initialPaperPositions];
  private equity = 100_000;
  private startEquity = 100_000;
  private lastPrices: Record<string, number> = {};

  getAccount() {
    const marginUsed = this.positions.reduce(
      (sum, pos) => sum + (pos.qty * pos.mark) / (pos.leverage || 1),
      0
    );
    return { equity: this.equity, marginUsed };
  }

  getPositions(): Position[] {
    return [...this.positions];
  }

  openPosition(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    leverage: number;
    stopLoss?: number;
    takeProfit?: number;
    reduceOnly?: boolean;
    entryPrice?: number;
  }): { orderId: number; status: string } {
    const side = params.side === 'BUY' ? 'LONG' : 'SHORT';
    const mark = params.entryPrice || this.lastPrices[params.symbol] || params.stopLoss || 0;
    const pos: PaperPosition = {
      id: `${params.symbol}_${Date.now()}`,
      orderId: String(Date.now()),
      symbol: params.symbol,
      side,
      strategy: 'EXECUTOR-ε',
      entry: mark,
      qty: params.qty,
      mark,
      upnl: 0,
      upnlPct: 0,
      leverage: params.leverage,
      marginType: 'ISOLATED',
      liqDistancePct: params.stopLoss && mark > 0
        ? Math.abs((params.stopLoss - mark) / mark) * 100 * 2
        : null,
      serverSl: params.stopLoss ? String(params.stopLoss) : '—',
      serverTp: params.takeProfit ? String(params.takeProfit) : 'trail',
    };
    if (!params.reduceOnly) {
      this.positions.push(pos);
    }
    return { orderId: Date.now(), status: 'FILLED' };
  }

  cancelAll(_symbol: string) {
    this.positions = [];
  }

  markAll(prices: Record<string, number>) {
    Object.assign(this.lastPrices, prices);
    const btc = prices['BTCUSDT'] ?? prices['BTC/USDT'];
    const eth = prices['ETHUSDT'] ?? prices['ETH/USDT'];
    const sol = prices['SOLUSDT'] ?? prices['SOL/USDT'];
    const avax = prices['AVAXUSDT'] ?? prices['AVAX/USDT'];

    for (const pos of this.positions) {
      let mark = prices[pos.symbol] ?? prices[pos.symbol.replace('/', '')];
      if (!mark) {
        if (pos.symbol === 'BTC/ETH' && btc && eth) mark = btc / eth;
        else if (pos.symbol === 'SOL/AVAX' && sol && avax) mark = sol / avax;
      }
      if (!mark) continue;

      const direction = pos.side === 'LONG' ? 1 : -1;
      pos.mark = mark;
      pos.upnl = (mark - pos.entry) * pos.qty * direction;
      pos.upnlPct = pos.entry ? ((mark - pos.entry) / pos.entry) * 100 * direction : 0;
    }
    this.equity = this.startEquity + this.positions.reduce((sum, pos) => sum + pos.upnl, 0);
  }
}
