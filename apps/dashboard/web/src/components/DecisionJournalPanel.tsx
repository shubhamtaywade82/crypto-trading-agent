/**
 * DecisionJournalPanel — real-time feed of autonomous agent decisions,
 * strategy setups, and risk guardrail interventions. Replaces generic
 * tables with an actionable agentic event stream.
 */

import { useState } from "react";
import { useDashboardStore, type DecisionRow } from "../store.js";

const STATUS_FILTERS = [
  "ALL",
  "EXECUTED",
  "RISK_REJECTED",
  "VETOED",
  "EQ_REJECTED",
  "FRICTION_REJECTED",
  "EXECUTION_REFUSED",
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

export default function DecisionJournalPanel({ className }: { className: string }) {
  const decisions = useDashboardStore((s) => s.decisions);
  const refusals = useDashboardStore((s) => s.decisionRefusals);
  const [filter, setFilter] = useState<StatusFilter>("ALL");

  const filtered = filter === "ALL" ? decisions : decisions.filter((d) => d.status === filter);

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <span>Autonomous Reasoning &amp; Decision Stream</span>
        <span className="spacer" />
        {refusals && refusals.total > 0 && (
          <span className="badge-warn">{refusals.total} Interventions</span>
        )}
      </div>

      <div className="feed-filter-bar">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            className={`feed-filter-pill ${filter === s ? "active" : ""}`}
            onClick={() => setFilter(s)}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="panel-body no-pad">
        <div className="decision-feed">
          {filtered.length === 0 && (
            <div className="feed-empty-state">
              <span>No decisions match the selected filter. Monitoring live cycles.</span>
            </div>
          )}
          {filtered.map((d) => (
            <DecisionEventCard key={d.decisionId} item={d} />
          ))}
        </div>
      </div>
    </section>
  );
}

function DecisionEventCard({ item }: { item: DecisionRow }) {
  const isBuy = item.side.includes("BUY") || item.side.includes("LONG");
  const time = new Date(item.timestamp).toLocaleTimeString();
  const reasoning = item.reason ?? item.refusalReason;

  return (
    <div className={`decision-event-card status-${item.status}`}>
      <div className="event-meta-line">
        <span className="agent-badge">{item.strategy || "COUNCIL"}</span>
        <span className="target-symbol">{item.symbol}</span>
        <span className={`side-tag ${isBuy ? "buy" : "sell"}`}>{item.side}</span>
        <span className="spacer" />
        <span className={`event-status-tag ${item.status}`}>
          {formatStatus(item.status)}
        </span>
        <span className="event-time">{time}</span>
      </div>

      {reasoning && (
        <div className="agent-thought-quote">
          <span className="thought-icon">💡</span>
          <span className="thought-text">{reasoning}</span>
        </div>
      )}

      {(item.entry || item.stopLoss || item.takeProfit || item.notionalUsdt) && (
        <div className="event-trade-specs">
          {item.entry ? <span className="spec-val">Entry: ${item.entry.toFixed(2)}</span> : null}
          {item.stopLoss ? <span className="spec-val text-dn">SL: ${item.stopLoss.toFixed(2)}</span> : null}
          {item.takeProfit ? <span className="spec-val text-up">TP: ${item.takeProfit.toFixed(2)}</span> : null}
          {item.notionalUsdt ? <span className="spec-val text-muted">${item.notionalUsdt.toFixed(0)} USDT</span> : null}
        </div>
      )}
    </div>
  );
}

function formatStatus(status: string): string {
  switch (status) {
    case "EXECUTED":
      return "ORDER EXECUTED";
    case "RISK_REJECTED":
      return "RISK VETO";
    case "VETOED":
      return "COUNCIL VETO";
    case "EXECUTION_REFUSED":
      return "VENUE REFUSED";
    default:
      return status.replace(/_/g, " ");
  }
}
