/**
 * DecisionJournalPanel — recent decisions from data/decisions.jsonl with
 * filterable status. Refusals summary mirrors scripts/analyze-decisions.ts.
 */

import { useState } from "react";
import { useDashboardStore } from "../store.js";

const STATUS_FILTERS = [
  "ALL",
  "EXECUTED",
  "RISK_REJECTED",
  "VETOED",
  "EQ_REJECTED",
  "EXECUTION_REFUSED",
  "EXECUTION_FAILED",
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
        Decision Journal
        <span className="spacer" />
        <span className="text-dim" style={{ textTransform: "none", letterSpacing: 0, fontSize: 10 }}>
          {refusals ? `${refusals.total} rejections` : ""}
        </span>
      </div>
      <div className="panel-body no-pad">
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", display: "flex", gap: 4, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={filter === s ? "active" : ""}
              onClick={() => setFilter(s)}
              style={{ fontSize: 10, padding: "2px 6px" }}
            >
              {s}
            </button>
          ))}
        </div>
        <table className="decisions-table">
          <thead>
            <tr>
              <th>time</th>
              <th>sym</th>
              <th>side</th>
              <th>strategy</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">No decisions in journal.</td>
              </tr>
            )}
            {filtered.map((d) => (
              <tr key={d.decisionId}>
                <td className="text-dim">{formatTime(d.timestamp)}</td>
                <td>{d.symbol}</td>
                <td className={d.side === "BUY" ? "text-up" : "text-dn"}>{d.side}</td>
                <td className="text-muted">{d.strategy}</td>
                <td><span className={`status-pill ${d.status}`}>{d.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
