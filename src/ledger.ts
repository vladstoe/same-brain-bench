import fs from "node:fs";
import type { CostReport, LedgerRow, PhaseCost, PriceTable } from "./types.ts";
import { addBuckets, emptyBuckets, priceBuckets, priceTableUsable } from "./pricing.ts";
import { exists } from "./util.ts";
import { mergeUsage, normaliseUsage } from "../proxy/usage.ts";

export function readLedger(file: string): LedgerRow[] {
  if (!exists(file)) return [];
  const rows: LedgerRow[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed) as LedgerRow);
    } catch {
      // A truncated final line is the only shape this hits; skipping it never
      // turns a real call into zeros, it just leaves it out of the count.
    }
  }
  return rows;
}

function blankPhaseCost(): PhaseCost {
  return { buckets: emptyBuckets(), calls: 0, unknownCalls: 0, usd: null };
}

/**
 * Buckets are re-derived from `usage.raw` whenever it is there. The stored buckets
 * were computed by whatever merge was current when the row was written, so a row
 * recorded before a metering fix keeps the old, wrong numbers forever otherwise —
 * which is exactly what happened to the cache-write tiers.
 */
export function rederive(row: LedgerRow): LedgerRow {
  if (row.usage === "unknown") return row;
  const raw = row.usage.raw;
  if (raw === null || typeof raw !== "object") return row;

  const parts = raw as Record<string, unknown>;
  const fresh =
    "message_start" in parts || "message_delta" in parts
      ? mergeUsage(normaliseUsage(parts["message_start"]), normaliseUsage(parts["message_delta"]))
      : normaliseUsage(raw);

  return fresh === null ? row : { ...row, usage: fresh };
}

export function summarise(
  attemptId: string,
  rows: LedgerRow[],
  table: PriceTable,
): CostReport {
  const perPhase: Record<string, PhaseCost> = {};
  const totals = blankPhaseCost();
  const markers = new Map<string, number>();
  const unattributed = { calls: 0, buckets: emptyBuckets(), rows: [] as string[] };

  for (const raw of rows) {
    const row = rederive(raw);
    if (!row.metered) continue;

    // Rows that arrived while no phase was active are listed, never counted.
    if (row.attribution === "unattributed") {
      unattributed.calls += 1;
      if (row.usage !== "unknown") unattributed.buckets = addBuckets(unattributed.buckets, row.usage);
      unattributed.rows.push(`${row.ts} ${row.requestId ?? "no-request-id"} ${row.model ?? "?"}`);
      continue;
    }

    const phase = row.phase ?? "unattributed";
    const bucket = (perPhase[phase] ??= blankPhaseCost());
    bucket.calls += 1;
    totals.calls += 1;
    markers.set(row.clientMarker, (markers.get(row.clientMarker) ?? 0) + 1);

    if (row.usage === "unknown") {
      bucket.unknownCalls += 1;
      totals.unknownCalls += 1;
      continue;
    }
    bucket.buckets = addBuckets(bucket.buckets, row.usage);
    totals.buckets = addBuckets(totals.buckets, row.usage);
  }

  const usable = priceTableUsable(table);
  for (const cost of Object.values(perPhase)) cost.usd = priceBuckets(cost.buckets, table);
  totals.usd = priceBuckets(totals.buckets, table);

  return {
    attemptId,
    priced: totals.usd !== null,
    priceTable: table,
    unpricedReason: totals.usd === null ? usable.reason : null,
    totals,
    perPhase,
    retryGroups: [...markers.entries()]
      .filter(([, count]) => count > 1)
      .map(([clientMarker, rowsCount]) => ({ clientMarker, rows: rowsCount }))
      .sort((a, b) => a.clientMarker.localeCompare(b.clientMarker)),
    unattributed,
  };
}
