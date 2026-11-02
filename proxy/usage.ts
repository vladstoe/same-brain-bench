import type { NormalisedUsage } from "../src/types.ts";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  [k: string]: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function normaliseUsage(raw: unknown): NormalisedUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const u = raw as RawUsage;
  const hasAny =
    "input_tokens" in u ||
    "output_tokens" in u ||
    "cache_read_input_tokens" in u ||
    "cache_creation_input_tokens" in u ||
    "cache_creation" in u;
  if (!hasAny) return null;

  const breakdown = u.cache_creation;
  const has5m = typeof breakdown?.ephemeral_5m_input_tokens === "number";
  const has1h = typeof breakdown?.ephemeral_1h_input_tokens === "number";
  const totalWrite = num(u.cache_creation_input_tokens);

  let cacheWrite5m = num(breakdown?.ephemeral_5m_input_tokens);
  const cacheWrite1h = num(breakdown?.ephemeral_1h_input_tokens);
  let assumed = false;
  if (!has5m && !has1h && totalWrite > 0) {
    cacheWrite5m = totalWrite;
    assumed = true;
  }

  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteTierAssumed: assumed,
    raw,
  };
}

export function mergeUsage(
  base: NormalisedUsage | null,
  next: NormalisedUsage | null,
): NormalisedUsage | null {
  if (base === null) return next;
  if (next === null) return base;
  // Cache writes merge as a unit, never per tier. message_start reports the real
  // split (5m/1h) while message_delta usually reports only the aggregate, which
  // normalises to assumed-5m; taking the max of each tier independently then counts
  // the same tokens twice -- 24488 in 1h from start plus 24488 in 5m from delta.
  const write = mergeCacheWrite(base, next);
  return {
    input: Math.max(base.input, next.input),
    output: Math.max(base.output, next.output),
    cacheRead: Math.max(base.cacheRead, next.cacheRead),
    cacheWrite5m: write.cacheWrite5m,
    cacheWrite1h: write.cacheWrite1h,
    cacheWriteTierAssumed: write.cacheWriteTierAssumed,
    raw: { message_start: base.raw, message_delta: next.raw },
  };
}

function cacheWriteTotal(u: NormalisedUsage): number {
  return u.cacheWrite5m + u.cacheWrite1h;
}

/**
 * A side carrying a real tier breakdown is authoritative for the split. Only when
 * neither does is the total treated as assumed-5m. Either way the invariant holds:
 * cacheWrite5m + cacheWrite1h === max(total on each side).
 */
function mergeCacheWrite(
  base: NormalisedUsage,
  next: NormalisedUsage,
): Pick<NormalisedUsage, "cacheWrite5m" | "cacheWrite1h" | "cacheWriteTierAssumed"> {
  const total = Math.max(cacheWriteTotal(base), cacheWriteTotal(next));
  const real = [base, next].filter((u) => !u.cacheWriteTierAssumed && cacheWriteTotal(u) > 0);
  const authority = real.sort((a, b) => cacheWriteTotal(b) - cacheWriteTotal(a))[0];

  if (authority === undefined) {
    return { cacheWrite5m: total, cacheWrite1h: 0, cacheWriteTierAssumed: total > 0 };
  }
  // Scale the authoritative split up to the larger total if the other side saw more.
  const known = cacheWriteTotal(authority);
  if (known >= total || known === 0) {
    return {
      cacheWrite5m: authority.cacheWrite5m,
      cacheWrite1h: authority.cacheWrite1h,
      cacheWriteTierAssumed: false,
    };
  }
  return {
    cacheWrite5m: authority.cacheWrite5m + (total - known),
    cacheWrite1h: authority.cacheWrite1h,
    cacheWriteTierAssumed: true,
  };
}

export interface StreamScan {
  usage: NormalisedUsage | null;
  model: string | null;
  messageId: string | null;
}

/**
 * Incremental SSE reader. Bytes are forwarded to the client untouched; this only
 * observes them, so a malformed frame degrades to "usage unknown" and never to zeros.
 */
export class SseUsageScanner {
  private buffer = "";
  private startUsage: NormalisedUsage | null = null;
  private deltaUsage: NormalisedUsage | null = null;
  model: string | null = null;
  messageId: string | null = null;

  push(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trimEnd();
      this.buffer = this.buffer.slice(idx + 1);
      this.consumeLine(line);
    }
    if (this.buffer.length > 1_000_000) this.buffer = "";
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = event["type"];
    if (type === "message_start") {
      const message = event["message"] as Record<string, unknown> | undefined;
      if (message) {
        if (typeof message["model"] === "string") this.model = message["model"];
        if (typeof message["id"] === "string") this.messageId = message["id"];
        this.startUsage = normaliseUsage(message["usage"]) ?? this.startUsage;
      }
    } else if (type === "message_delta") {
      this.deltaUsage = normaliseUsage(event["usage"]) ?? this.deltaUsage;
    }
  }

  result(): StreamScan {
    return {
      usage: mergeUsage(this.startUsage, this.deltaUsage),
      model: this.model,
      messageId: this.messageId,
    };
  }
}

export function scanJsonBody(body: Buffer): StreamScan {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    return {
      usage: normaliseUsage(parsed["usage"]),
      model: typeof parsed["model"] === "string" ? parsed["model"] : null,
      messageId: typeof parsed["id"] === "string" ? parsed["id"] : null,
    };
  } catch {
    return { usage: null, model: null, messageId: null };
  }
}
