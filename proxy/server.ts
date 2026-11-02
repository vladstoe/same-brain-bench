import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LedgerRow } from "../src/types.ts";
import { SseUsageScanner, scanJsonBody } from "./usage.ts";

export interface ProxyOptions {
  host: string;
  port: number;
  upstream: string;
  ledgerPath: string;
  attemptId: string;
  arm: string;
  n: number | null;
  phase: string;
  contextFile?: string;
  onRow?: (row: LedgerRow) => void;
}

interface Attribution {
  attemptId: string;
  arm: string;
  n: number | null;
  phase: string;
  active?: boolean;
}

const UNATTRIBUTED: Attribution = {
  attemptId: "unattributed",
  arm: "unattributed",
  n: null,
  phase: "unattributed",
  active: false,
};

/**
 * Two spellings, because the two SDKs disagree about where the version segment
 * lives. The official Anthropic SDK treats the base URL as the origin and asks
 * for /v1/messages; the Vercel AI SDK folds /v1 into its default base URL, so a
 * base URL without it produces a bare /messages. Metering only /v1/messages
 * would silently miss every call from the second one.
 */
const METERED_PATHS = new Set(["/v1/messages", "/messages"]);

/**
 * The three Claude Code request headers that say which session, and which kind of
 * request, a call was. No other header is recorded.
 */
export function claudeCodeHeaders(headers: http.IncomingHttpHeaders): Pick<LedgerRow, "sessionId" | "xApp" | "agentId"> {
  const one = (name: string): string | null => {
    const v = headers[name];
    const first = Array.isArray(v) ? v[0] : v;
    return first === undefined || first === "" ? null : first;
  };
  return {
    sessionId: one("x-claude-code-session-id"),
    xApp: one("x-app"),
    agentId: one("x-claude-code-agent-id"),
  };
}

export function createProxy(opts: ProxyOptions): http.Server {
  fs.mkdirSync(path.dirname(opts.ledgerPath), { recursive: true });
  const upstream = new URL(opts.upstream);
  const agent =
    upstream.protocol === "https:"
      ? new https.Agent({ keepAlive: true })
      : new http.Agent({ keepAlive: true });

  let contextCache: { mtimeMs: number; value: Partial<Attribution> } | null = null;

  const fileAttribution = (): Partial<Attribution> => {
    if (!opts.contextFile) return {};
    try {
      const st = fs.statSync(opts.contextFile);
      if (contextCache === null || contextCache.mtimeMs !== st.mtimeMs) {
        contextCache = {
          mtimeMs: st.mtimeMs,
          value: JSON.parse(fs.readFileSync(opts.contextFile, "utf8")) as Partial<Attribution>,
        };
      }
      return contextCache.value;
    } catch {
      return {};
    }
  };

  /**
   * A context file that says `active: false` means no phase is running, so a
   * call reaching the proxy belongs to something the rig is not measuring.
   * Headers still win, because only the rig sets them.
   */
  const attribute = (headers: http.IncomingHttpHeaders): Attribution => {
    const header = (name: string): string | undefined => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const headerAttempt = header("x-rig-attempt");
    const headerArm = header("x-rig-arm");
    const headerPhase = header("x-rig-phase");
    const nRaw = header("x-rig-n");
    if (
      headerAttempt !== undefined ||
      headerArm !== undefined ||
      headerPhase !== undefined ||
      nRaw !== undefined
    ) {
      return {
        attemptId: headerAttempt ?? opts.attemptId,
        arm: headerArm ?? opts.arm,
        n: nRaw !== undefined ? Number(nRaw) : opts.n,
        phase: headerPhase ?? opts.phase,
        active: true,
      };
    }

    if (opts.contextFile !== undefined) {
      const fromFile = fileAttribution();
      if (fromFile.active !== true) return UNATTRIBUTED;
      return {
        attemptId: fromFile.attemptId ?? opts.attemptId,
        arm: fromFile.arm ?? opts.arm,
        n: fromFile.n ?? opts.n,
        phase: fromFile.phase ?? opts.phase,
        active: true,
      };
    }

    return { attemptId: opts.attemptId, arm: opts.arm, n: opts.n, phase: opts.phase, active: true };
  };

  const append = (row: LedgerRow): void => {
    fs.appendFileSync(opts.ledgerPath, JSON.stringify(row) + "\n");
    opts.onRow?.(row);
  };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      forward(req, res, body, started);
    });
    req.on("error", () => res.destroy());
  });

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    started: number,
  ): void {
    const attr = attribute(req.headers);
    const url = new URL(req.url ?? "/", upstream);
    const pathname = url.pathname;
    const metered = req.method === "POST" && METERED_PATHS.has(pathname);
    const clientMarker = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const retryHeader = req.headers["x-stainless-retry-count"];
    const retryCount =
      typeof retryHeader === "string" && retryHeader !== "" ? Number(retryHeader) : null;
    const auth: LedgerRow["auth"] = req.headers["x-api-key"]
      ? "x-api-key"
      : req.headers["authorization"]
        ? "bearer"
        : "none";
    const claude = claudeCodeHeaders(req.headers);

    // Headers pass through unchanged except Host, which must name the upstream, and
    // Accept-Encoding. Clients ask for gzip; a compressed body cannot be read for its
    // usage block, and decompressing inline would mean re-encoding the stream the
    // client is waiting on. Asking upstream for identity keeps the bytes readable and
    // still lets them reach the client untouched.
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers["host"];
    delete headers["connection"];
    delete headers["accept-encoding"];
    headers["host"] = upstream.host;
    headers["accept-encoding"] = "identity";
    if (body.length > 0) headers["content-length"] = String(body.length);

    const transport = upstream.protocol === "https:" ? https : http;
    const upReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: url.pathname + url.search,
        headers,
        agent,
      },
      (upRes) => {
        const contentType = String(upRes.headers["content-type"] ?? "");
        const isStream = contentType.includes("text/event-stream");
        // If upstream compressed anyway, the body cannot be read. Say so on the row
        // rather than reporting an unexplained "unknown".
        const encoding = String(upRes.headers["content-encoding"] ?? "").toLowerCase();
        const compressed = /\b(gzip|deflate|br|zstd)\b/.test(encoding);
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);

        const scanner = isStream && !compressed ? new SseUsageScanner() : null;
        const collected: Buffer[] = [];
        let collectedBytes = 0;

        upRes.on("data", (chunk: Buffer) => {
          res.write(chunk);
          if (scanner) {
            scanner.push(chunk);
          } else if (!compressed && collectedBytes < 8_000_000) {
            collected.push(chunk);
            collectedBytes += chunk.length;
          }
        });

        upRes.on("end", () => {
          res.end();
          const scan = compressed
            ? { usage: null, model: null, messageId: null }
            : scanner
              ? scanner.result()
              : scanJsonBody(Buffer.concat(collected));
          const requestId = upRes.headers["request-id"];
          append({
            ts: new Date().toISOString(),
            attemptId: attr.attemptId,
            arm: attr.arm,
            n: attr.n,
            phase: attr.phase,
            metered,
            method: req.method ?? "GET",
            path: pathname,
            status: upRes.statusCode ?? null,
            stream: isStream,
            requestId: typeof requestId === "string" ? requestId : null,
            messageId: scan.messageId,
            model: scan.model,
            clientMarker,
            retryCount,
            auth,
            attribution: attr.active === true ? "attributed" : "unattributed",
            usage: scan.usage ?? "unknown",
            durationMs: Date.now() - started,
            ...(compressed ? { note: `compressed response (${encoding}); not scanned` } : {}),
            ...claude,
          });
        });

        upRes.on("error", () => res.destroy());
      },
    );

    upReq.on("error", (err) => {
      append({
        ts: new Date().toISOString(),
        attemptId: attr.attemptId,
        arm: attr.arm,
        n: attr.n,
        phase: attr.phase,
        metered,
        method: req.method ?? "GET",
        path: pathname,
        status: null,
        stream: false,
        requestId: null,
        messageId: null,
        model: null,
        clientMarker,
        retryCount,
        auth,
        attribution: attr.active === true ? "attributed" : "unattributed",
        usage: "unknown",
        durationMs: Date.now() - started,
        transportError: String(err),
        ...claude,
      });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: String(err) } }));
    });

    if (body.length > 0) upReq.write(body);
    upReq.end();
  }

  return server;
}

export function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
