import type { Buckets, PriceTable } from "./types.ts";

export const BUCKET_KEYS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

export function emptyBuckets(): Buckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addBuckets(a: Buckets, b: Buckets): Buckets {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

export function missingPrices(table: PriceTable): string[] {
  return BUCKET_KEYS.filter((k) => typeof table[k] !== "number");
}

export function priceTableUsable(table: PriceTable): { usable: boolean; reason: string | null } {
  const missing = missingPrices(table);
  if (missing.length > 0) {
    return { usable: false, reason: `price table has no value for: ${missing.join(", ")}` };
  }
  if (table.verifiedOn === null) {
    return { usable: false, reason: "price table verifiedOn is null; prices are not confirmed" };
  }
  return { usable: true, reason: null };
}

/** USD for the buckets, or null when the frozen table is not usable. */
export function priceBuckets(buckets: Buckets, table: PriceTable): number | null {
  if (missingPrices(table).length > 0) return null;
  let usd = 0;
  for (const k of BUCKET_KEYS) {
    usd += (buckets[k] / 1_000_000) * (table[k] as number);
  }
  return Math.round(usd * 1e8) / 1e8;
}
