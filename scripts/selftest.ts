import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createProxy, listen } from "../proxy/server.ts";
import { readLedger, rederive, summarise } from "../src/ledger.ts";
import { clopperPearson } from "../src/stats.ts";
import { detectQuestion } from "../src/prompts.ts";
import { auditTranscripts } from "../src/audit.ts";
import { classify } from "../src/classify.ts";
import { loadConfig, rigRoot } from "../src/config.ts";
import type { AttemptRecord, AuditRecord, BenchConfig, LedgerRow, Phase, PhaseRecord, PriceTable } from "../src/types.ts";
import { readJson, walk } from "../src/util.ts";
import { epicFor } from "../src/traycer-epic.ts";
import { buildReport, loadAttempts } from "../src/report.ts";
import { attemptPaths, scratchPaths } from "../src/paths.ts";
import {
  CANARY_TOKENS,
  ancestorInstructionFiles,
  readCurrentProviderVersion,
} from "../src/preflight.ts";
import {
  findReply,
  toAuditTranscript,
  readChat,
  readChatSettings,
} from "../src/traycer-store.ts";
import { mergeUsage, normaliseUsage } from "../proxy/usage.ts";
import { carriedState } from "../src/audit.ts";
import { priceBuckets } from "../src/pricing.ts";
import { storeUsage } from "../src/traycer-store.ts";
import { reconcile, reconcileAdjustmentsV3 } from "../src/reconcile.ts";
import { noteSurfaceSources, takeSnapshot } from "../src/snapshot.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { TraycerChat } from "../src/traycer-store.ts";
import { dryChat } from "../arms/traycer-dryrun.ts";
import { cloneSeed, inspectSeedClone, seedRepoChecks, writeSeedManifests } from "../src/seed-clone.ts";
import { buildManifest, seedNoteHashes, type SeedManifest } from "../src/manifest.ts";
import { baseArgs as claudeBaseArgs, env as claudeEnv, runClaude } from "../arms/claude.ts";
import { phasePolicy } from "../src/reply-policy.ts";
import { approvalPolicy } from "../src/prompts.ts";
import { routingEnv } from "../src/routing.ts";
import { runTraycer } from "../arms/traycer.ts";
import { createArgs, DryRunTraycerCli } from "../src/traycer-cli.ts";
import { writeRouting } from "../src/routing.ts";
import { readProviderOverrides, reservedHarnessKeys } from "../src/preflight.ts";
import { attributeCalls, claudeProjectSlug, leaveOutForeign } from "../src/sessions.ts";
import { readChatAt, rosterSessionIds } from "../src/traycer-store.ts";
import { phaseConfig } from "../src/config.ts";
import { benchGuide, closeWindow, equalSetupChecks, openWindow, windowPaths, windowState } from "../src/equal-setup.ts";
import { depthsBelow, retireEpic } from "../src/retire.ts";
import {
  artifactStatuses,
  attemptAgents,
  collectSessions,
  collectUnmapped,
  measureAgents,
  phaseSessionsOf,
  readAgentRecords,
  sessionsDir,
  subagentFilesUnder,
  tallyVersions,
  turnEffort,
  auditTranscriptsV3,
  harnessOverhead,
  projectFolder,
  unmappedDir,
  type AgentFiles,
} from "../src/v3-measures.ts";
import { pinnedBuildProblem, readPinnedBuild } from "../src/preflight.ts";
import { subagentArchiveDir } from "../src/sessions.ts";
import { archiveSubagentTree } from "../arms/claude.ts";
import type { RosterEntry } from "../src/types.ts";


// The dry runs here clone the seed repo the dry-run config names.
if (!fs.existsSync(path.join(rigRoot, ".seed-repo", ".git"))) {
  console.error("rig selftest: .seed-repo is missing; run scripts/make-seed-repo.sh first");
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rig-selftest-"));
const prices = readJson<PriceTable>(path.join(rigRoot, "scripts", "test-prices.json"));
let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  PASS  ${name}`))
    .catch((err: unknown) => {
      failures += 1;
      console.log(`  FAIL  ${name}\n        ${String(err).split("\n")[0]}`);
      if (err instanceof assert.AssertionError) {
        const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 300) ?? String(v);
        console.log(`        expected ${show(err.expected)}\n        received ${show(err.actual)}`);
      }
    });
}

const seenAcceptEncoding: string[] = [];

async function fakeUpstream(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // Records what the proxy actually forwarded, so a test can assert it.
    seenAcceptEncoding.push(String(req.headers["accept-encoding"] ?? "(absent)"));

    // Compresses only if the forwarded request still asks for it. A proxy that
    // passes the client's `accept-encoding: gzip` through lands here and gets a
    // body its scanner cannot read.
    // A stubborn upstream that compresses whatever was asked for: the case the
    // `note` field exists to make visible.
    if (url.pathname === "/v1/messages" && url.searchParams.get("stream") === "3") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "request-id": "req_stubborn_1",
      });
      res.end(zlib.gzipSync(Buffer.from("event: message_stop\ndata: {}\n\n", "utf8")));
      return;
    }

    if (url.pathname === "/v1/messages" && url.searchParams.get("stream") === "2") {
      const frames =
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_gzip_1",
            model: "gzip-model",
            usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 2 },
          },
        })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 7 },
        })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
      const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      if (wantsGzip) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
          "request-id": "req_gzip_1",
        });
        res.end(zlib.gzipSync(Buffer.from(frames, "utf8")));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_gzip_1" });
        res.end(frames);
      }
      return;
    }

    if (url.pathname === "/v1/messages" && url.searchParams.get("stream") === "1") {
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_stream_1" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_stream_1",
            model: "test-model",
            usage: {
              input_tokens: 100,
              output_tokens: 1,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 25,
              cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 10 },
            },
          },
        })}\n\n`,
      );
      res.write(`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 33 },
        })}\n\n`,
      );
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return;
    }
    if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_json_1" });
      res.end(
        JSON.stringify({
          id: "msg_json_1",
          model: "test-model",
          usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0 },
        }),
      );
      return;
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function proxyTests(): Promise<void> {
  const upstream = await fakeUpstream();
  const ledgerPath = path.join(tmp, "proxy-ledger.jsonl");
  const server = createProxy({
    host: "127.0.0.1",
    port: 0,
    upstream: upstream.url,
    ledgerPath,
    attemptId: "X-1",
    arm: "X",
    n: 1,
    phase: "A",
  });
  await listen(server, "127.0.0.1", 0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const streamRes = await fetch(`${base}/v1/messages?stream=1`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test", "x-rig-phase": "B" },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  const streamBody = await streamRes.text();

  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
  });
  // Same body twice: the client marker must group them as one retry pair.
  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-test",
      "x-stainless-retry-count": "1",
    },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
  });
  // A client that folds /v1 into its base URL emits a bare path.
  await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat-test" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "oauth" }] }),
  });
  // Node's fetch sends `accept-encoding: gzip, deflate` by default; be explicit so
  // the test states what it is exercising rather than relying on the runtime.
  const gzipRes = await fetch(`${base}/v1/messages?stream=2`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-test",
      "accept-encoding": "gzip, deflate",
    },
    body: JSON.stringify({ model: "gzip-model", messages: [] }),
  });
  const gzipBody = await gzipRes.text();

  await fetch(`${base}/v1/messages?stream=3`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test" },
    body: JSON.stringify({ model: "stubborn", messages: [] }),
  });

  await fetch(`${base}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test" },
    body: JSON.stringify({ messages: [] }),
  });

  server.close();
  upstream.close();

  const rows = readLedger(ledgerPath);

  await check("streaming body reaches the client intact", () => {
    assert.ok(streamBody.includes("message_start"), "no message_start frame");
    assert.ok(streamBody.includes("message_stop"), "no message_stop frame");
    assert.equal(streamRes.headers.get("content-type"), "text/event-stream");
  });

  await check("streamed response is logged with the merged final usage block", () => {
    const row = rows.find((r) => r.stream) as LedgerRow;
    assert.ok(row, "no streaming row");
    assert.notEqual(row.usage, "unknown");
    const u = row.usage as Exclude<LedgerRow["usage"], "unknown">;
    assert.equal(u.input, 100);
    assert.equal(u.output, 33, "message_delta output_tokens must win over message_start");
    assert.equal(u.cacheRead, 40);
    assert.equal(u.cacheWrite5m, 15);
    assert.equal(u.cacheWrite1h, 10);
    assert.equal(row.requestId, "req_stream_1");
    assert.equal(row.messageId, "msg_stream_1");
    assert.equal(row.model, "test-model");
    assert.equal(row.auth, "x-api-key");
    assert.equal(row.phase, "B", "an x-rig-phase header must override the launch attribution");
  });

  await check("a bare /messages POST is metered too", () => {
    const row = rows.find((r) => r.path === "/messages") as LedgerRow;
    assert.ok(row, "no /messages row");
    assert.equal(row.metered, true, "the Vercel AI SDK spelling must be metered");
    assert.notEqual(row.usage, "unknown");
    assert.equal(row.auth, "bearer", "an OAuth turn arrives as a bearer token");
  });

  await check("a gzip-capable client still yields a readable usage block", () => {
    const row = rows.find((r) => r.requestId === "req_gzip_1") as LedgerRow;
    assert.ok(row, "no gzip-path row");
    assert.notEqual(
      row.usage,
      "unknown",
      "upstream compressed the body, so the SSE scanner saw bytes it could not read",
    );
    const u = row.usage as Exclude<LedgerRow["usage"], "unknown">;
    assert.equal(u.input, 11);
    assert.equal(u.output, 7);
    assert.equal(row.model, "gzip-model");
    assert.ok(gzipBody.includes("message_stop"), "the client still received the frames");
  });

  await check("the forwarded request asks upstream for identity encoding", () => {
    assert.ok(seenAcceptEncoding.length > 0, "upstream saw no requests");
    const bad = seenAcceptEncoding.filter((v) => v !== "identity");
    assert.deepEqual(bad, [], `every forwarded request must ask for identity, saw: ${bad.join(", ")}`);
  });

  await check("a compressed response says so instead of failing silently", () => {
    const row = rows.find((r) => r.requestId === "req_stubborn_1") as LedgerRow;
    assert.ok(row, "no stubborn-upstream row");
    assert.equal(row.usage, "unknown");
    assert.match(row.note ?? "", /compressed response \(gzip\); not scanned/);
  });

  await check("count_tokens is relayed but not metered", () => {
    const row = rows.find((r) => r.path === "/v1/messages/count_tokens") as LedgerRow;
    assert.ok(row, "no count_tokens row");
    assert.equal(row.metered, false);
    const metered = rows.filter((r) => r.metered);
    assert.equal(metered.length, 6);
  });

  await check("retries share one client marker and are both counted", () => {
    const cost = summarise("X-1", rows, prices);
    const groups = cost.retryGroups;
    assert.equal(groups.length, 1, `expected one retry group, got ${groups.length}`);
    assert.equal(groups[0]?.rows, 2);
    assert.equal(cost.totals.calls, 6);
  });

  await check("the proxy records Claude Code's session, app and agent headers, null when absent, and no other header", async () => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stub" } }));
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const ledger = path.join(tmp, "proxy-headers.jsonl");
    const proxy = createProxy({
      host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
      ledgerPath: ledger, attemptId: "X-1", arm: "X", n: 1, phase: "A",
    });
    await listen(proxy, "127.0.0.1", 0);
    const at = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/messages`;
    await fetch(at, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer SECRET-OAUTH-VALUE",
        "X-Claude-Code-Session-Id": "sess-own",
        "x-app": "cli-bg",
        "x-claude-code-agent-id": "agent-9",
        "x-claude-code-prompt-id": "PROMPT-ID-VALUE",
      },
      body: "{}",
    });
    await fetch(at, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "SECRET-KEY-VALUE" }, body: "{}" });
    proxy.close();
    stub.close();
    const got = readLedger(ledger).map((r) => [r.sessionId, r.xApp, r.agentId, r.auth]);
    assert.deepEqual(got, [["sess-own", "cli-bg", "agent-9", "bearer"], [null, null, null, "x-api-key"]]);
    const text = fs.readFileSync(ledger, "utf8");
    for (const secret of ["SECRET-OAUTH-VALUE", "SECRET-KEY-VALUE", "PROMPT-ID-VALUE"]) assert.equal(text.includes(secret), false, secret);
  });
}

async function ledgerTests(): Promise<void> {
  const file = path.join(tmp, "synthetic.jsonl");
  const base = {
    ts: "2026-09-16T00:00:00.000Z",
    attemptId: "C-1",
    arm: "C",
    n: 1,
    metered: true,
    attribution: "attributed" as const,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    stream: false,
    messageId: null,
    model: "SYNTHETIC-TEST-MODEL",
    retryCount: 0,
    auth: "x-api-key" as const,
    durationMs: 10,
  };
  const usage = (i: number, o: number, r: number, w5: number, w1: number) => ({
    input: i,
    output: o,
    cacheRead: r,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    cacheWriteTierAssumed: false,
    raw: {},
  });
  const rows: LedgerRow[] = [
    { ...base, phase: "A", requestId: "req_1", clientMarker: "aaaa", usage: usage(1_000_000, 0, 0, 0, 0) },
    { ...base, phase: "A", requestId: "req_2", clientMarker: "bbbb", usage: "unknown" },
    { ...base, phase: "B", requestId: "req_3", clientMarker: "cccc", usage: usage(0, 500_000, 2_000_000, 0, 0) },
    {
      ...base,
      phase: "B",
      requestId: "req_4",
      clientMarker: "cccc",
      retryCount: 1,
      usage: usage(0, 500_000, 2_000_000, 100_000, 50_000),
    },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  await check("synthetic ledger prices to the expected USD with unknownCalls: 1", () => {
    const cost = summarise("C-1", readLedger(file), prices);
    // A: 1e6 input @ $10/M                                    = 10
    // B: 1e6 output @ $100/M + 4e6 cacheRead @ $1/M
    //    + 1e5 write5m @ $20/M + 5e4 write1h @ $40/M           = 100 + 4 + 2 + 2 = 108
    assert.equal(cost.perPhase["A"]?.usd, 10);
    assert.equal(cost.perPhase["A"]?.unknownCalls, 1);
    assert.equal(cost.perPhase["B"]?.usd, 108);
    assert.equal(cost.totals.usd, 118);
    assert.equal(cost.totals.unknownCalls, 1);
    assert.equal(cost.totals.calls, 4);
    assert.equal(cost.retryGroups.length, 1);
    assert.equal(cost.retryGroups[0]?.clientMarker, "cccc");
  });

  // Its own table, not the live config's: this pins the pricing function's
  // behaviour, and must not start passing or failing because someone filled
  // bench.config.json in.
  const unverified: PriceTable = {
    ...prices,
    verifiedOn: null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
  };

  await check("an unverified price table refuses to produce USD", () => {
    const cost = summarise("C-1", readLedger(file), unverified);
    assert.equal(cost.totals.usd, null);
    assert.equal(cost.priced, false);
    assert.ok(cost.unpricedReason !== null);
    assert.equal(cost.totals.buckets.input, 1_000_000, "raw buckets are still reported");
  });

  await check("a priced-but-unconfirmed table still refuses", () => {
    const cost = summarise("C-1", readLedger(file), { ...prices, verifiedOn: null });
    assert.equal(cost.priced, true, "values present, so USD is computed");
    const usable = summarise("C-1", readLedger(file), prices);
    assert.equal(usable.totals.usd, 118, "the verified table prices as before");
  });
}

async function statsTests(): Promise<void> {
  await check("Clopper-Pearson matches the published 95% bounds", () => {
    const near = (a: number, b: number, eps = 5e-4): void => {
      assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
    };
    const zero = clopperPearson(0, 3);
    near(zero.lower, 0);
    near(zero.upper, 0.7076);
    const one = clopperPearson(1, 3);
    near(one.lower, 0.0084);
    near(one.upper, 0.9057);
    const all = clopperPearson(3, 3);
    near(all.lower, 0.2924);
    near(all.upper, 1);
    const half = clopperPearson(5, 10);
    near(half.lower, 0.1871);
    near(half.upper, 0.8129);
  });
}

async function questionTests(): Promise<void> {
  await check("question detection separates approvals from questions", () => {
    assert.equal(detectQuestion("Plan written to PLAN.md.").isQuestion, false);
    assert.equal(detectQuestion("Shall I proceed with option B?").kind, "approval");
    assert.equal(detectQuestion("Which approach do you prefer?").isQuestion, true);
    assert.equal(detectQuestion("Should the cancel route soft-delete?").kind, "question");
    assert.equal(detectQuestion("").isQuestion, false);
  });
}

async function auditTests(): Promise<void> {
  const work = path.join(tmp, "audit-work");
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(tmp, "transcript.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: path.join(work, "src/db.ts") } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "cat /home/someone/.claude/secrets" } },
          ],
        },
      }),
    ].join("\n"),
  );

  await check("audit flags reads outside the worktree and carried state", () => {
    const result = auditTranscripts("C-1", [work], [{ phase: "B", file }]);
    assert.equal(result.clean, false);
    const paths = result.offendingPaths.map((o) => o.path);
    assert.ok(paths.includes("/etc/hosts"));
    assert.ok(paths.includes("/home/someone/.claude/secrets"));
    assert.equal(paths.length, 2, `in-worktree read must not be flagged: ${paths.join(", ")}`);
  });
}

async function traycerTests(): Promise<void> {
  const cfg = loadConfig(path.join(rigRoot, "scripts", "dryrun.v3.json"));

  await check("unattributed rows are listed but never counted", () => {
    const file = path.join(tmp, "unattributed.jsonl");
    const base = {
      ts: "2026-09-16T00:00:00.000Z",
      attemptId: "T-1",
      arm: "T",
      n: 1,
      metered: true,
      method: "POST",
      path: "/v1/messages",
      status: 200,
      stream: false,
      messageId: null,
      model: "m",
      retryCount: 0,
      auth: "x-api-key" as const,
      durationMs: 5,
    };
    const u = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteTierAssumed: false,
      raw: {},
    };
    const rows: LedgerRow[] = [
      { ...base, phase: "A", requestId: "r1", clientMarker: "a", attribution: "attributed", usage: u },
      {
        ...base,
        phase: "unattributed",
        requestId: "r2",
        clientMarker: "b",
        attribution: "unattributed",
        usage: u,
      },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const cost = summarise("T-1", readLedger(file), prices);
    assert.equal(cost.totals.calls, 1, "the unattributed row must not be counted");
    assert.equal(cost.totals.usd, 10);
    assert.equal(cost.unattributed.calls, 1);
    assert.equal(cost.unattributed.buckets.input, 1_000_000);
  });

  await check("arm T refuses an attempt with no configured epic", () => {
    assert.throws(() => epicFor(cfg, 99), /no traycer.attempts/);
  });

  await check("the cumulative adapter total is read, never summed", () => {
    const chat = dryChat("c1", "success", "/tmp/work", false);
    const usage = storeUsage([chat]);
    // Two snapshots of 1.25 and 2.50; summing them would report 3.75.
    assert.equal(usage?.usd, 2.5);
    assert.equal(usage?.output, null, "token fields are final-call snapshots, never reported");
  });

  await check("null native tokens with matching USD reconcile unflagged", () => {
    const record = {
      attemptId: "T-1",
      arm: "T",
      n: 1,
      phases: {
        A: {
          phase: "A",
          nativeUsage: {
            input: null,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            usd: 10.6864602,
            source: "traycer chat store, cumulative costUsd summed over 3 agent(s)",
          },
        },
      },
    } as unknown as AttemptRecord;
    const cost = {
      perPhase: {
        A: {
          buckets: { input: 947, output: 25765, cacheRead: 3116341, cacheWrite5m: 0, cacheWrite1h: 1193013 },
          calls: 40,
          unknownCalls: 0,
          usd: 10.6864602,
        },
      },
    } as unknown as Parameters<typeof reconcile>[1];
    const r = reconcile(record, cost, 0.02);
    assert.equal(r.phases[0]?.tokenRatio, null, "null token fields must not produce a ratio");
    assert.ok((r.phases[0]?.usdRatio ?? 1) < 1e-9, "USD matches exactly");
    assert.equal(r.phases[0]?.flagged, false, "a matching USD with no token basis must not flag");
    assert.equal(r.flagged, false);
  });

  await check("Skill tool calls are detectable in the chat store shape", () => {
    const chat = dryChat("c1", "success", "/tmp/work", false);
    const skills = chat.turns.flatMap((t) => t.skillLoads);
    assert.ok(skills.includes("traycer-tech-plan"), `skills seen: ${skills.join(",")}`);
  });

  await check("a turn on an env credential classifies authChannelMismatch", () => {
    const phase = {
      phase: "A",
      arm: "T",
      timedOut: false,
      unansweredQuestion: false,
      scriptedReplies: [],
      wallClockMs: 10,
      traycer: { envCredentialVars: [null, "ANTHROPIC_API_KEY"], authChannelOk: false },
    };
    const record = {
      attemptId: "T-1",
      arm: "T",
      phases: { A: phase },
      manifestCheckAfterA: { ok: true, changed: [], missing: [] },
    } as unknown as AttemptRecord;
    const verdict = classify(record, {
      completion: { renew: true, cancel: true, availability: true },
      decisions: { D1: true, D2: true, D3: true, D4: true },
    });
    assert.equal(verdict.outcome, "failure");
    assert.equal(verdict.failureCause, "authChannelMismatch");
    assert.match(verdict.reason, /env credential instead of the signed-in profile/);
  });

  // The sender's inbox is unreliable with a GUI sender, so completion is read from
  // the child's own send block. These pin what counts as a match.
  const SENDER = "sender-aaaa";
  const THREAD = "resp-bbbb";
  const chatWithSend = (
    over: Partial<{ receiverAgentId: string | null; responseId: string | null; status: string }>,
    timestamp = 1_000,
  ): TraycerChat => ({
    chatId: "child-1",
    available: true,
    note: null,
    turnCount: 1,
    turnCountSource: "assistantTurnIds",
    turns: [
      {
        messageId: "m1",
        turnId: "t1",
        role: "assistant",
        timestamp,
        envCredentialVar: null,
        hasEnvCredentialField: true,
        text: "ready",
        toolCalls: [],
        skillLoads: [],
        sends: [
          {
            receiverAgentId: SENDER,
            responseId: THREAD,
            message: "ready",
            expectReply: false,
            status: "completed",
            ...over,
          },
        ],
        usage: null,
      },
    ],
  });

  await check("the child's send block counts as the reply", () => {
    const hit = findReply(chatWithSend({}), SENDER, THREAD);
    assert.ok(hit !== null, "the matching send block was not found");
    assert.equal(hit?.message, "ready");
    assert.equal(hit?.at, 1_000, "the send block's own timestamp is the settle time");
  });

  await check("a send on another thread is ignored", () => {
    assert.equal(findReply(chatWithSend({ responseId: "resp-other" }), SENDER, THREAD), null);
  });

  await check("a send to another agent is ignored", () => {
    assert.equal(findReply(chatWithSend({ receiverAgentId: "someone-else" }), SENDER, THREAD), null);
  });

  await check("an incomplete send is ignored", () => {
    assert.equal(findReply(chatWithSend({ status: "running" }), SENDER, THREAD), null);
  });

  await check("a reply to the previous message does not settle the next one", () => {
    const stale = chatWithSend({}, 1_000);
    assert.ok(findReply(stale, SENDER, THREAD, 500) !== null, "a send after the cutoff must match");
    assert.equal(
      findReply(stale, SENDER, THREAD, 5_000),
      null,
      "a send from before this message was dispatched must not settle it",
    );
  });

  // The host keeps its chat store in WAL mode and holds the connection open, so the
  // newest writes -- the ones this rig cares about -- are still in chat.db-wal.
  await check("a projection still in the WAL is read, not missed", async () => {
    const root = path.join(tmp, "wal-fixture");
    const epicId = "epic-wal";
    const chatDir = path.join(root, "host", "epic-state", epicId, "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    const dbFile = path.join(chatDir, "chat.db");
    const settings = JSON.stringify({
      harnessId: "codex",
      model: "gpt-6-luna",
      permissionMode: "full_access",
    });

    // stdin is deliberately left open: closing it would close the last connection,
    // and SQLite checkpoints and removes the WAL on a clean close.
    const writer = spawn("sqlite3", [dbFile], { stdio: ["pipe", "ignore", "ignore"] });
    writer.stdin.write(
      "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\n" +
        "CREATE TABLE chat_projection_head(chat_id TEXT PRIMARY KEY, through_seq INTEGER, title TEXT, lifecycle_state TEXT, settings_json TEXT);\n" +
        `INSERT INTO chat_projection_head VALUES('child-wal', 1, 't', 'active', '${settings.replace(/'/g, "''")}');\n` +
        "SELECT 1;\n",
    );

    const walFile = `${dbFile}-wal`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(walFile) && fs.statSync(walFile).size > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    try {
      assert.ok(fs.existsSync(walFile), "fixture did not produce a WAL");
      assert.ok(fs.statSync(walFile).size > 0, "fixture WAL is empty");

      // Negative control: the old behaviour, copying only the main file.
      const onlyMain = path.join(tmp, "wal-negative.db");
      fs.copyFileSync(dbFile, onlyMain);
      const solo = await new Promise<string>((resolve) => {
        const p2 = spawn("sqlite3", [onlyMain, "select settings_json from chat_projection_head;"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        p2.stdout.on("data", (c: Buffer) => (out += c.toString()));
        p2.on("close", () => resolve(out.trim()));
      });
      assert.equal(solo, "", `copying chat.db alone must see nothing, saw: ${solo.slice(0, 60)}`);

      const cfg = {
        traycer: { epicsRoot: path.join(root, "epics") },
      } as unknown as BenchConfig;
      const settings = await readChatSettings(cfg, epicId, "child-wal", path.join(tmp, "wal-scratch"));
      assert.ok(settings !== null, "readChatSettings saw nothing; the WAL was not copied");
      assert.equal(settings?.harnessId, "codex");
      assert.equal(settings?.model, "gpt-6-luna");
    } finally {
      writer.kill("SIGKILL");
    }
  });

  await check("the preflight proxy context yields an attributed row", async () => {
    const upstream2 = await fakeUpstream();
    const ledgerPath2 = path.join(tmp, "preflight-ledger.jsonl");
    const contextFile = path.join(tmp, "preflight-context.json");
    // Exactly the object cmdPreflight writes.
    fs.writeFileSync(
      contextFile,
      JSON.stringify({ attemptId: "preflight", arm: "C", n: 0, phase: "preflight", active: true }),
    );
    const server2 = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstream: upstream2.url,
      ledgerPath: ledgerPath2,
      attemptId: "unset",
      arm: "unset",
      n: null,
      phase: "unset",
      contextFile,
    });
    await listen(server2, "127.0.0.1", 0);
    const port2 = (server2.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port2}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    server2.close();
    upstream2.close();
    const row = readLedger(ledgerPath2)[0] as LedgerRow;
    assert.ok(row, "no row");
    assert.equal(row.attribution, "attributed", "without active:true the probe row is excluded");
    assert.equal(row.arm, "C");
    assert.equal(row.phase, "preflight");
  });

  await check("the two canaries carry distinct tokens", () => {
    assert.notEqual(
      CANARY_TOKENS.realConfig,
      CANARY_TOKENS.ancestor,
      "one shared token cannot say which file was read",
    );
  });

  await check("an ancestor instruction file is seen from below", () => {
    const root = path.join(tmp, "ancestor-probe");
    const bench = path.join(root, "bench", "runs-root");
    fs.mkdirSync(bench, { recursive: true });
    assert.deepEqual(ancestorInstructionFiles(bench), [], "nothing planted yet");
    const planted = path.join(root, "CLAUDE.md");
    fs.writeFileSync(planted, `# canary\n${CANARY_TOKENS.ancestor}\n`);
    assert.ok(
      ancestorInstructionFiles(bench).includes(planted),
      "the guard `rig new` relies on did not see the ancestor file",
    );
  });

  await check("a stale claudeBinary pin is caught against current.json", () => {
    const root = path.join(tmp, "provider-pack", "darwin-arm64");
    fs.mkdirSync(path.join(root, "2.1.259"), { recursive: true });
    fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ version: "2.1.280" }));
    const pinned = path.join(root, "2.1.259", "claude");
    assert.equal(readCurrentProviderVersion(pinned), "2.1.280");
    assert.notEqual(readCurrentProviderVersion(pinned), "2.1.259", "a drifted pin must be visible");
    fs.writeFileSync(path.join(root, "current.json"), "not json");
    assert.equal(readCurrentProviderVersion(pinned), null, "unreadable pointer degrades to null");
  });

  await check("n = 0 resolves the throwaway smoke epic, not attempts[0]", () => {
    const zero = epicFor(cfg, 0);
    assert.equal(zero.epicId, cfg.traycer.smoke.epic, "n = 0 must use traycer.smoke");
    const one = epicFor(cfg, 1);
    assert.equal(one.epicId, cfg.traycer.attempts["1"]?.epic, "n = 1 must use traycer.attempts");
    assert.notEqual(zero.epicId, one.epicId, "the rehearsal must not touch a scored attempt's epic");
  });

  await check("smoke and preflight scratch sit outside the attempt namespace", () => {
    const attempt0 = attemptPaths(cfg, "T", 0).dir;
    const smoke = scratchPaths(cfg, "smoke", "T").dir;
    const pre = scratchPaths(cfg, "preflight", "C").dir;
    assert.notEqual(smoke, attempt0, "the smoke must not occupy the n = 0 attempt directory");
    assert.notEqual(pre, attemptPaths(cfg, "C", 0).dir);
    for (const d of [smoke, pre]) {
      assert.ok(path.basename(path.dirname(d)).startsWith("_") || path.basename(d).startsWith("_"),
        `${d} must be under an underscore directory so the report walk skips it`);
    }
  });

  await check("the report counts n = 1 and only lists n = 0", () => {
    const mk = (n: number, outcome: string) =>
      ({
        record: {
          attemptId: `C-${n}`,
          arm: "C",
          n,
          dryRun: false,
          phases: {},
          classification: { outcome, failureCause: null, exclusionCause: null, reason: "" },
        },
        cost: null,
        audit: null,
        reconcile: null,
        result: null,
      }) as unknown as Parameters<typeof buildReport>[1][number];

    const md = buildReport(cfg, [mk(0, "failure"), mk(1, "success")]);
    assert.match(md, /\| C \| 1 \/ 1 \|/, "the scored row must count only n = 1");
    assert.match(md, /Unscored live dry runs \(n = 0\)/, "n = 0 needs its own table");
    assert.match(md, /\| C-0 \|/, "n = 0 must still be listed");
    assert.doesNotMatch(md, /\| C \| 1 \/ 2 \|/, "n = 0 must not enter the denominator");
  });

  // Builds a chat store the way the host does: ops carry what has just happened, and
  // the folded head row lags them.
  const opLogDb = async (
    root: string,
    epicId: string,
    chatId: string,
    ops: unknown[],
    staleSettings: unknown,
  ): Promise<void> => {
    const dir = path.join(root, "host", "epic-state", epicId, "chat");
    fs.mkdirSync(dir, { recursive: true });
    const sql: string[] = [
      "CREATE TABLE chat_op_log(chat_id TEXT, seq INTEGER, op_id TEXT, op_json TEXT, recorded_at INTEGER);",
      "CREATE TABLE chat_projection_head(chat_id TEXT PRIMARY KEY, through_seq INTEGER, title TEXT, lifecycle_state TEXT, settings_json TEXT);",
    ];
    ops.forEach((op, i) => {
      const j = JSON.stringify(op).replace(/'/g, "''");
      sql.push(
        `INSERT INTO chat_op_log VALUES('${chatId}', ${i + 1}, 'op${i + 1}', '${j}', ${1000 + i});`,
      );
    });
    sql.push(
      `INSERT INTO chat_projection_head VALUES('${chatId}', 1, 't', 'active', '${JSON.stringify(staleSettings).replace(/'/g, "''")}');`,
    );
    await new Promise<void>((resolve) => {
      const p2 = spawn("sqlite3", [path.join(dir, "chat.db")], { stdio: ["pipe", "ignore", "ignore"] });
      p2.stdin.end(sql.join("\n") + "\n");
      p2.on("close", () => resolve());
    });
  };

  await check("turns are rebuilt from the op log, not the stale snapshot", async () => {
    const root = path.join(tmp, "oplog");
    const cfg = { traycer: { epicsRoot: path.join(root, "epics") } } as unknown as BenchConfig;
    const body = (blocks: unknown[], role = "assistant") => ({
      messageId: "m1",
      role,
      turnId: "t1",
      timestamp: 5_000,
      envCredentialVar: null,
      blocks,
      usage: { inputTokens: 1 },
    });
    await opLogDb(
      root,
      "E1",
      "c1",
      [
        // Successive upserts are full snapshots whose block list grows.
        { type: "message.upsert", messageId: "m1", message: body([]) },
        {
          type: "message.upsert",
          messageId: "m1",
          message: body([
            { type: "text", blockId: "b1", content: "hello" },
            { type: "tool_call", blockId: "b2", toolName: "Read", inputDetail: { entries: [] } },
          ]),
        },
        {
          type: "message.upsert",
          messageId: "m1",
          message: body([
            { type: "text", blockId: "b1", content: "hello" },
            { type: "tool_call", blockId: "b2", toolName: "Read", inputDetail: { entries: [] } },
            {
              type: "tool_call",
              blockId: "b3",
              toolName: "mcp__traycer_a2a__traycer_send_message",
              status: "completed",
              agentMessageSend: {
                receiverAgentId: "sender-1",
                responseId: "thread-1",
                message: "ready",
                expectReply: false,
              },
            },
          ]),
        },
        { type: "event.append", event: { message: "Turn completed." } },
      ],
      { harnessId: "claude" },
    );

    const chat = await readChat(cfg, "E1", "c1", path.join(tmp, "oplog-scratch"));
    assert.equal(chat.available, true, chat.note ?? "");
    assert.equal(chat.turns.length, 1);
    assert.equal(chat.turns[0]?.toolCalls.length, 2, "the snapshot had zero blocks");
    const hit = findReply(chat, "sender-1", "thread-1", 0);
    assert.ok(hit !== null, "the send block was invisible in the snapshot");
    assert.equal(hit?.message, "ready");
  });

  await check("settings come from the op log too, so a reconfigure is not missed", async () => {
    const root = path.join(tmp, "oplog-settings");
    const cfg = { traycer: { epicsRoot: path.join(root, "epics") } } as unknown as BenchConfig;
    await opLogDb(
      root,
      "E2",
      "c2",
      [
        { type: "chat.metadata", patch: { settings: { value: { harnessId: "claude" } } } },
        { type: "chat.metadata", patch: { settings: { value: { harnessId: "codex", model: "gpt" } } } },
      ],
      { harnessId: "claude" },
    );
    const settings = await readChatSettings(cfg, "E2", "c2", path.join(tmp, "oplog-settings-scratch"));
    assert.equal(settings?.harnessId, "codex", "the folded head row still said claude");
  });

  // A schema-20 store: the op log alongside the compacted `chat_message` and
  // `chat_event` tables. A migrated row carries a negative sequence, because the
  // host numbers the rows it writes while migrating below the op log's own space.
  const schema20Db = async (
    root: string,
    epicId: string,
    chatId: string,
    parts: {
      ops: unknown[];
      messages?: { id: string; seq: number; body: unknown }[];
      events?: { id: string; seq: number; body: unknown }[];
      headSettings?: unknown;
    },
  ): Promise<void> => {
    const dir = path.join(root, "host", "epic-state", epicId, "chat");
    fs.mkdirSync(dir, { recursive: true });
    const lit = (v: unknown): string => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    const sql: string[] = [
      "CREATE TABLE chat_op_log(chat_id TEXT, seq INTEGER, op_id TEXT, op_json TEXT, recorded_at INTEGER);",
      "CREATE TABLE chat_projection_head(chat_id TEXT PRIMARY KEY, through_seq INTEGER, title TEXT, lifecycle_state TEXT, settings_json TEXT);",
    ];
    if (parts.messages !== undefined) {
      sql.push(
        "CREATE TABLE chat_message(chat_id TEXT, message_id TEXT, insert_seq INTEGER, last_seq INTEGER, removed_seq INTEGER, body TEXT, PRIMARY KEY (chat_id, message_id));",
      );
    }
    if (parts.events !== undefined) {
      sql.push(
        "CREATE TABLE chat_event(chat_id TEXT, event_id TEXT, insert_seq INTEGER, last_seq INTEGER, event_type TEXT, body TEXT, PRIMARY KEY (chat_id, event_id));",
      );
    }
    parts.ops.forEach((op, i) => {
      sql.push(`INSERT INTO chat_op_log VALUES('${chatId}', ${i + 1}, 'op${i + 1}', ${lit(op)}, ${i});`);
    });
    for (const m of parts.messages ?? []) {
      sql.push(
        `INSERT INTO chat_message VALUES('${chatId}', '${m.id}', ${m.seq}, ${m.seq}, NULL, ${lit(m.body)});`,
      );
    }
    for (const e of parts.events ?? []) {
      sql.push(
        `INSERT INTO chat_event VALUES('${chatId}', '${e.id}', ${e.seq}, ${e.seq}, 'turn.completed', ${lit(e.body)});`,
      );
    }
    sql.push(
      `INSERT INTO chat_projection_head VALUES('${chatId}', 1, 't', 'active', ${lit(parts.headSettings ?? { harnessId: "claude" })});`,
    );
    await new Promise<void>((resolve) => {
      const p2 = spawn("sqlite3", [path.join(dir, "chat.db")], { stdio: ["pipe", "ignore", "ignore"] });
      p2.stdin.end(sql.join("\n") + "\n");
      p2.on("close", () => resolve());
    });
  };

  await check("a shell command is read whole, not from the truncated summary", async () => {
    const root = path.join(tmp, "input-detail");
    const cfg = { traycer: { epicsRoot: path.join(root, "epics") } } as unknown as BenchConfig;
    // The two shapes the host writes. `kind: "command"` was unread, so every arm-T
    // Bash call fell through to inputSummary, which the host cuts at ~78 characters.
    const COMMAND =
      "cd /w && for f in package.json tsconfig.json .gitignore src/*.ts src/routes/*.ts " +
      'test/*.ts; do echo "=== $f ==="; cat -n "$f"; done';
    const SUMMARY = "cd /w && for f in package.json tsconfig.json .gitignore src/*.ts src/ro…";
    await opLogDb(
      root,
      "E5",
      "c5",
      [
        {
          type: "message.upsert",
          messageId: "m1",
          message: {
            messageId: "m1",
            role: "assistant",
            turnId: "t1",
            timestamp: 9_000,
            envCredentialVar: null,
            usage: { costUsd: 1 },
            blocks: [
              {
                type: "tool_call",
                blockId: "b1",
                toolName: "Bash",
                startedAt: 8_000,
                inputDetail: { command: COMMAND, kind: "command" },
                inputSummary: SUMMARY,
              },
              {
                type: "tool_call",
                blockId: "b2",
                toolName: "Read",
                startedAt: 8_500,
                inputDetail: {
                  kind: "fields",
                  entries: [{ key: "file_path", label: "File path", value: "/w/src/db.ts" }],
                },
                inputSummary: "/w/src/db.ts",
              },
            ],
          },
        },
      ],
      { harnessId: "claude" },
    );

    const chat = await readChat(cfg, "E5", "c5", path.join(tmp, "input-detail-scratch"));
    const bash = chat.turns[0]?.toolCalls[0];
    assert.equal(bash?.input["command"], COMMAND, `expected the whole command, received ${bash?.input["command"]}`);
    assert.equal(
      bash?.input["command"]?.includes("…"),
      false,
      `the truncated summary reached the reader: ${SUMMARY}`,
    );
    assert.equal(bash?.at, 8_000, "the block's own start time");
    // The fields shape still works, and `kind` is never mistaken for an argument.
    assert.equal(chat.turns[0]?.toolCalls[1]?.input["file_path"], "/w/src/db.ts");
    assert.equal(chat.turns[0]?.toolCalls[1]?.input["kind"], undefined);
  });

  await check("a schema-20 chat is read from the op log and the compacted tables together", async () => {
    const root = path.join(tmp, "schema20");
    const cfg = { traycer: { epicsRoot: path.join(root, "epics") } } as unknown as BenchConfig;
    const msg = (id: string, turnId: string, blocks: unknown[]) => ({
      messageId: id,
      role: "assistant",
      turnId,
      timestamp: 5_000,
      envCredentialVar: null,
      blocks,
      usage: { costUsd: 1 },
    });
    const sendBlock = {
      type: "tool_call",
      blockId: "b-send",
      toolName: "mcp__traycer_a2a__traycer_send_message",
      status: "completed",
      agentMessageSend: {
        receiverAgentId: "sender-1",
        responseId: "thread-1",
        message: "done",
        expectReply: false,
      },
    };
    const text = { type: "text", blockId: "b-text", content: "working" };

    await schema20Db(root, "E3", "c3", {
      ops: [
        // The state the log kept for m1 is the one from before the reply went out.
        { type: "message.upsert", messageId: "m1", message: msg("m1", "t1", [text]) },
        // m2 and its event exist only in the log: written since the last fold.
        { type: "message.upsert", messageId: "m2", message: msg("m2", "t2", [text]) },
        {
          type: "event.append",
          eventId: "e-log",
          event: { eventId: "e-log", type: "turn.completed", message: "Turn completed." },
        },
      ],
      messages: [
        // m1's final state, the only place the send block survives.
        { id: "m1", seq: 9, body: msg("m1", "t1", [text, sendBlock]) },
        // A migrated row: a negative sequence, and richer than anything in the log.
        { id: "m0", seq: -3, body: msg("m0", "t0", [text, { ...text, blockId: "b-text-2" }]) },
      ],
      events: [
        { id: "e-table", seq: 4, body: { eventId: "e-table", type: "turn.completed", message: "Turn completed." } },
      ],
    });

    const chat = await readChat(cfg, "E3", "c3", path.join(tmp, "schema20-scratch"));
    assert.equal(chat.available, true, chat.note ?? "");
    assert.deepEqual(
      chat.turns.map((t) => t.messageId),
      ["m0", "m1", "m2"],
      "the migrated message sorts ahead of the ones added after it",
    );

    const reply = findReply(chat, "sender-1", "thread-1", 0);
    assert.ok(reply !== null, "the send block lives only in chat_message and was lost");
    assert.equal(reply?.message, "done");

    const m0 = chat.turns.find((t) => t.messageId === "m0");
    assert.equal(m0?.toolCalls.length, 0);
    assert.equal(
      chat.turns.find((t) => t.messageId === "m2") !== undefined,
      true,
      "a message written since the last fold exists only in the op log",
    );

    assert.equal(chat.turnCount, 2, "one turn from the log, one from the table, deduped by id");
    assert.equal(chat.turnCountSource, "turnCompletedEvents");

    // Settings: the op log carries none here, so the head row is what answers.
    const settings = await readChatSettings(cfg, "E3", "c3", path.join(tmp, "schema20-settings"));
    assert.equal(settings?.harnessId, "claude");

    // Negative control: the same chat with the compacted tables absent, which is
    // what the reader saw before this change.
    await schema20Db(root, "E4", "c3", {
      ops: [
        { type: "message.upsert", messageId: "m1", message: msg("m1", "t1", [text]) },
        { type: "message.upsert", messageId: "m2", message: msg("m2", "t2", [text]) },
        {
          type: "event.append",
          eventId: "e-log",
          event: { eventId: "e-log", type: "turn.completed", message: "Turn completed." },
        },
      ],
    });
    const logOnly = await readChat(cfg, "E4", "c3", path.join(tmp, "schema20-negative"));
    assert.equal(
      findReply(logOnly, "sender-1", "thread-1", 0),
      null,
      "expected the op log alone to miss the reply; it found one, so the fixture is wrong",
    );
    assert.equal(logOnly.turns.length, 2, "expected 2 messages from the log alone");
    assert.equal(logOnly.turnCount, 1, "expected 1 turn event from the log alone");
  });

  await check("cache writes are not double counted across start and delta", () => {
    // The exact pair from the first live arm-C row.
    const start = normaliseUsage({
      input_tokens: 4,
      output_tokens: 1,
      cache_creation_input_tokens: 24488,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 24488 },
    });
    const delta = normaliseUsage({ output_tokens: 700, cache_creation_input_tokens: 24488 });
    const merged = mergeUsage(start, delta);
    assert.ok(merged !== null);
    assert.equal(merged?.cacheWrite1h, 24488, "the real 1h split must survive");
    assert.equal(merged?.cacheWrite5m, 0, "the aggregate must not reappear as a second 5m charge");
    assert.equal(
      (merged?.cacheWrite5m ?? 0) + (merged?.cacheWrite1h ?? 0),
      24488,
      "invariant: tiers sum to max(total on either side)",
    );
    assert.equal(merged?.output, 700);
  });

  await check("a merge with no real breakdown still totals correctly", () => {
    const a = normaliseUsage({ cache_creation_input_tokens: 100 });
    const b = normaliseUsage({ cache_creation_input_tokens: 140 });
    const merged = mergeUsage(a, b);
    assert.equal((merged?.cacheWrite5m ?? 0) + (merged?.cacheWrite1h ?? 0), 140);
    assert.equal(merged?.cacheWriteTierAssumed, true, "assumed tiers must stay flagged");
  });

  await check("zero readable turns is an exclusion, not an auth mismatch", () => {
    const record = {
      attemptId: "T-0",
      arm: "T",
      n: 0,
      phases: {
        A: {
          phase: "A",
          arm: "T",
          timedOut: false,
          unansweredQuestion: false,
          scriptedReplies: [],
          wallClockMs: 1,
          traycer: { envCredentialVars: [], authChannelOk: false },
        },
      },
      manifestCheckAfterA: { ok: true, changed: [], missing: [] },
    } as unknown as AttemptRecord;
    const verdict = classify(record, {
      completion: { renew: true },
      decisions: { D1: true },
    });
    assert.equal(verdict.outcome, "infrastructureExcluded");
    assert.equal(verdict.exclusionCause, "transcriptUnreadable");
    assert.doesNotMatch(verdict.reason, /credential/, "must not blame the auth channel");
  });

  await check("ledger re-derives buckets from usage.raw", () => {
    // A row as it was written before the merge fix: tiers double counted, but the
    // raw frames that produced them are still on the row.
    const stale = {
      metered: true,
      attribution: "attributed",
      usage: {
        input: 2,
        output: 131,
        cacheRead: 0,
        cacheWrite5m: 24488,
        cacheWrite1h: 24488,
        cacheWriteTierAssumed: false,
        raw: {
          message_start: {
            input_tokens: 2,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 24488,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 24488 },
          },
          message_delta: {
            input_tokens: 2,
            output_tokens: 131,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 24488,
          },
        },
      },
    } as unknown as LedgerRow;

    const fixed = rederive(stale);
    const u = fixed.usage as Exclude<LedgerRow["usage"], "unknown">;
    assert.equal(u.cacheWrite1h, 24488);
    assert.equal(u.cacheWrite5m, 0, "the stored double count must not survive a re-derive");
    assert.equal(u.output, 131);
    assert.equal(
      (stale.usage as Exclude<LedgerRow["usage"], "unknown">).cacheWrite5m,
      24488,
      "rederive must not mutate the row it was given",
    );
  });

  await check("a row without raw, or with unknown usage, is left alone", () => {
    const unknown = { metered: true, usage: "unknown" } as unknown as LedgerRow;
    assert.equal(rederive(unknown).usage, "unknown");
    const noRaw = {
      metered: true,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 3, cacheWrite1h: 4, cacheWriteTierAssumed: false, raw: null },
    } as unknown as LedgerRow;
    const u = rederive(noRaw).usage as Exclude<LedgerRow["usage"], "unknown">;
    assert.equal(u.cacheWrite5m, 3, "no raw means the stored buckets stand");
  });

  await check("the shared node_modules is an allowed read for every arm", () => {
    const paths = { work: "/bench/runs/C/1/work", claudeConfig: "/bench/runs/C/1/claude-config" } as unknown as Parameters<typeof carriedState>[1];
    const shared = "/bench/shared/node_modules";
    const file = path.join(tmp, "nm-audit.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "tool_use", name: "Bash", input: { command: `ls ${shared}` } }),
        JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "/bench/runs/C/2/work/src/db.ts" } }),
      ].join("\n"),
    );
    for (const arm of ["C", "T"] as const) {
      const result = auditTranscripts("X", carriedState(arm, paths, { sharedNodeModules: shared }), [
        { phase: "A", file },
      ]);
      const flagged = result.offendingPaths.map((o) => o.path);
      assert.deepEqual(
        flagged,
        ["/bench/runs/C/2/work/src/db.ts"],
        `arm ${arm} flagged: ${flagged.join(", ")}`,
      );
    }
  });

  await check("route literals in written source are not read as file paths", () => {
    const work = path.join(tmp, "routes-work");
    fs.mkdirSync(work, { recursive: true });
    const real = path.join(tmp, "routes-elsewhere.txt");
    fs.writeFileSync(real, "x");
    const file = path.join(tmp, "routes-audit.jsonl");
    fs.writeFileSync(
      file,
      [
        // Source code the agent is writing, full of absolute-looking route strings.
        JSON.stringify({
          type: "tool_use",
          name: "Bash",
          input: {
            command:
              "python3 - <<'EOF'\ns=s.replace(\"/loans/999/renew\", \"/books/1/availability\")\nEOF",
          },
        }),
        // A real file outside the allowed roots still offends.
        JSON.stringify({ type: "tool_use", name: "Bash", input: { command: `cat ${real}` } }),
        // A redirect to the null device is not a read.
        JSON.stringify({
          type: "tool_use",
          name: "Bash",
          input: { command: "rm -f x 2>/dev/null; npm test >/dev/null 2>&1" },
        }),
        // An explicit path argument offends even if it no longer exists.
        JSON.stringify({
          type: "tool_use",
          name: "Read",
          input: { file_path: "/gone/deleted-since.txt" },
        }),
      ].join("\n"),
    );
    const result = auditTranscripts("C-0", [work], [{ phase: "B", file }]);
    const flagged = result.offendingPaths.map((o) => o.path).sort();
    assert.deepEqual(flagged, [real, "/gone/deleted-since.txt"].sort(), `flagged: ${flagged.join(", ")}`);
  });

  await check("the project slug matches the one Claude Code actually wrote", () => {
    // Observed on the first live arm-T attempt.
    assert.equal(
      claudeProjectSlug("/private/tmp/cold-handoff-runs/runs/T/0/work"),
      "-private-tmp-cold-handoff-runs-runs-T-0-work",
    );
  });

  await check("arm T may read its own spill directory but not another attempt's", () => {
    const work = "/bench/runs/T/0/work";
    const cfgDir = "/home/u/.claude";
    const mine = `${cfgDir}/projects/${claudeProjectSlug(work)}/sess/tool-results/a.txt`;
    const theirs = `${cfgDir}/projects/${claudeProjectSlug("/bench/runs/T/1/work")}/sess/tool-results/b.txt`;
    const file = path.join(tmp, "spill-audit.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: mine } }),
        JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: theirs } }),
      ].join("\n"),
    );
    const roots = carriedState("T", { work } as unknown as Parameters<typeof carriedState>[1], {
      realClaudeConfigDir: cfgDir,
    });
    const result = auditTranscripts("T-0", roots, [{ phase: "B", file }]);
    assert.deepEqual(
      result.offendingPaths.map((o) => o.path),
      [theirs],
      "only another attempt's slug may offend",
    );
  });

  await check("arm T native usage takes cumulative costUsd, never the token snapshots", () => {
    // Shapes from the live store: costUsd rises, cacheCreationInputTokens falls.
    const chat = (id: string, usages: Record<string, number>[]): TraycerChat => ({
      chatId: id,
      available: true,
      note: null,
      turnCount: usages.length,
      turnCountSource: "assistantMessages",
      turns: usages.map((u, i) => ({
        messageId: `${id}-${i}`,
        turnId: null,
        role: "assistant",
        timestamp: i,
        envCredentialVar: null,
        hasEnvCredentialField: true,
        text: "",
        toolCalls: [],
        skillLoads: [],
        sends: [],
        usage: u,
      })),
    });
    const a = chat("a", [
      { cacheCreationInputTokens: 1225, cacheReadInputTokens: 149573, costUsd: 2.345975 },
      { cacheCreationInputTokens: 960, cacheReadInputTokens: 159149, costUsd: 2.7422008 },
    ]);
    const b = chat("b", [{ cacheCreationInputTokens: 10, cacheReadInputTokens: 20, costUsd: 1.102363 }]);

    const native = storeUsage([a]);
    assert.ok(native !== null);
    // The last snapshot only: 2.3460 and 2.7422 are cumulative, so summing to 5.09
    // would double count, and the earlier value alone would understate.
    assert.ok(Math.abs((native?.usd ?? 0) - 2.7422008) < 1e-9, `usd was ${native?.usd}`);
    // A sibling agent on another harness must never be folded in.
    const withSibling = storeUsage([a, b]);
    assert.ok(
      Math.abs((withSibling?.usd ?? 0) - 3.8445638) < 1e-9,
      "storeUsage sums what it is given, so callers must pass the child alone",
    );
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      assert.equal(native?.[k], null, `${k} must be null: the token fields are final-call snapshots`);
    }
  });

  await check("all-null native tokens reconcile as not-comparable, not as 100% off", () => {
    const record = {
      attemptId: "T-0",
      arm: "T",
      n: 0,
      phases: {
        A: {
          phase: "A",
          nativeUsage: { input: null, output: null, cacheRead: null, cacheWrite: null, usd: 4, source: "s" },
        },
      },
    } as unknown as AttemptRecord;
    const cost = {
      perPhase: { A: { buckets: { input: 10, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, calls: 1, unknownCalls: 0, usd: 4 } },
    } as unknown as Parameters<typeof reconcile>[1];
    const r = reconcile(record, cost, 0.02);
    assert.equal(r.phases[0]?.nativeTokens, null, "null fields must not sum to zero");
    assert.equal(r.phases[0]?.tokenRatio, null, "a 1.0 ratio would read as a 100% discrepancy");
    assert.match(r.phases[0]?.note ?? "", /not comparable/);
  });

  await check("the plan-turn snapshot copies note surfaces and grades an empty one", () => {
    const from = path.join(tmp, "snap-src");
    fs.mkdirSync(path.join(from, "plan"), { recursive: true });
    fs.writeFileSync(path.join(from, "plan", "index.md"), "the plan\n");
    const target = path.join(tmp, "snap-dest");
    const snap = takeSnapshot("T", target, [
      { from, relTarget: "artifacts", origin: "epic/artifacts" },
    ]);
    assert.equal(snap.files.length, 1);
    assert.equal(snap.files[0]?.relPath, path.join("artifacts", "plan", "index.md"));
    assert.equal(snap.wroteNothingDurable, false);
    assert.ok(fs.existsSync(path.join(target, "artifacts", "plan", "index.md")), "copy is on disk");

    const empty = takeSnapshot("C", path.join(tmp, "snap-empty"), [
      { from: path.join(tmp, "does-not-exist"), relTarget: "worktree", origin: "added" },
    ]);
    assert.equal(empty.wroteNothingDurable, true, "no note surface is itself the finding");
  });

  await check("a single-file snapshot source lands at its path, not inside a directory of its own name", () => {
    const work = path.join(tmp, "snap-nest-src");
    fs.mkdirSync(path.join(work, "docs", "loan-lifecycle"), { recursive: true });
    fs.writeFileSync(path.join(work, "CLAUDE.md"), "notes\n");
    fs.writeFileSync(path.join(work, "docs", "loan-lifecycle", "PLAN.md"), "the plan\n");
    const target = path.join(tmp, "snap-nest-dest");

    const snap = takeSnapshot("C", target, [
      {
        from: path.join(work, "CLAUDE.md"),
        relTarget: path.join("worktree", "CLAUDE.md"),
        origin: "noteSurface",
      },
      {
        from: path.join(work, "docs", "loan-lifecycle", "PLAN.md"),
        relTarget: path.join("worktree", "docs", "loan-lifecycle", "PLAN.md"),
        origin: "added",
      },
    ]);

    assert.deepEqual(
      snap.files.map((f) => f.relPath),
      [
        path.join("worktree", "CLAUDE.md"),
        path.join("worktree", "docs", "loan-lifecycle", "PLAN.md"),
      ],
    );
    for (const file of snap.files) {
      const dest = path.join(target, file.relPath);
      assert.ok(fs.existsSync(dest), `${file.relPath} is not on disk`);
      assert.ok(fs.statSync(dest).isFile(), `${file.relPath} is a directory, not the file`);
    }
    // The exact shape of the defect: a directory named after the file, holding it.
    assert.equal(
      fs.existsSync(path.join(target, "worktree", "CLAUDE.md", "CLAUDE.md")),
      false,
      "the file was nested one level deep again",
    );
  });

  await check("arm T audit flags a read outside the worktree and the epic", () => {
    const work = path.join(tmp, "t-work");
    fs.mkdirSync(work, { recursive: true });
    const file = path.join(tmp, "t-transcript.jsonl");
    fs.writeFileSync(file, toAuditTranscript(dryChat("c1", "success", work, true)));
    const clean = auditTranscripts("T-1", [work, "/tmp/epic"], [{ phase: "B", file }]);
    assert.equal(clean.clean, false);
    assert.ok(clean.offendingPaths.some((o) => o.path === "/etc/hosts"));
    assert.equal(clean.offendingPaths.length, 1, "the in-worktree read must not be flagged");
  });

  await check("arm T may read Traycer's own skill files but not the rest of ~/.traycer", () => {
    const work = path.join(tmp, "t-skills-work");
    fs.mkdirSync(work, { recursive: true });
    const epicsRoot = path.join(tmp, "traycer-home", "epics");
    const skills = path.join(path.dirname(epicsRoot), ".claude", "skills");
    const file = path.join(tmp, "t-skills-transcript.jsonl");

    // The read the traycer-implement skill itself instructs, and one that is not.
    const hostStore = path.join(path.dirname(epicsRoot), "host", "epic-state", "E9", "chat", "chat.db");
    const read = (p2: string) => ({ type: "tool_use", name: "Read", input: { file_path: p2 } });
    fs.writeFileSync(
      file,
      [read(path.join(skills, "traycer-references", "loop-protocol.md")), read(hostStore)]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    const roots = carriedState("T", { work, claudeConfig: "" } as never, {
      traycerSkillsRoot: skills,
    });
    const result = auditTranscripts("T-1", roots, [{ phase: "B", file }]);
    assert.deepEqual(
      result.offendingPaths.map((o) => o.path),
      [hostStore],
      "the skill reference is the harness; the host's chat store is not",
    );
  });
}

/** A throwaway seed: one commit, `main` and the tag, like seed v2. Never the real one. */
function fakeSeed(name: string): { repo: string; commit: string } {
  const repo = path.join(tmp, name);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# seed notes\n");
  fs.writeFileSync(path.join(repo, "package.json"), '{ "name": "seed", "version": "1.0.0" }\n');
  fs.writeFileSync(path.join(repo, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  fs.writeFileSync(path.join(repo, "src", "db.ts"), "export const db = 1;\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");
  git("tag", "seed-v2");
  return { repo, commit: git("rev-parse", "HEAD") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One epic and one sender per entry, mapped whole or not at all, attempt keys 1 to k, and no id used twice. */
function v3EpicMappingProblems(c: BenchConfig): string[] {
  const problems: string[] = [];
  for (const [name, pair] of [["smoke", c.traycer.smoke], ...Object.entries(c.traycer.attempts)] as const) {
    const keys = Object.keys(pair).sort();
    if (keys.join(",") !== "epic,sender") problems.push(`${name}: keys ${keys.join(",")}`);
    const ids: unknown[] = Object.values(pair);
    if (!ids.every((id) => id === null) && !ids.every((id) => typeof id === "string" && UUID.test(id))) {
      problems.push(`${name}: partly mapped`);
    }
  }
  for (const key of Object.keys(c.traycer.attempts)) {
    if (!/^[1-9][0-9]*$/.test(key) || Number(key) > c.k) problems.push(`attempt ${key} is outside 1 to ${c.k}`);
  }
  return [...problems, ...repeatedIdProblems(c)];
}

function repeatedIdProblems(c: BenchConfig): string[] {
  const seen = new Map<string, number>();
  const walkIds = (v: unknown): void => {
    if (typeof v === "string" && UUID.test(v)) seen.set(v, (seen.get(v) ?? 0) + 1);
    else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) walkIds(x);
  };
  walkIds(c);
  return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} appears ${n} times`);
}

function seedCfg(seedRepoPath: string, extra: Partial<BenchConfig> = {}): BenchConfig {
  return {
    ...loadConfig(path.join(rigRoot, "scripts", "dryrun.v3.json")),
    seedRepoPath,
    benchRoot: path.join(tmp, "seed-bench"),
    ...extra,
  };
}

async function seedTests(): Promise<void> {
  console.log("seed");

  const seed = fakeSeed("seed-v2-fake");

  await check("a clone holds the tag's commit, the tag as its only ref, no remote and a clean tree", async () => {
    const work = path.join(tmp, "clone-ok");
    const { check: c, problems } = await cloneSeed(seedCfg(seed.repo), work, seed.commit);
    assert.deepEqual(problems, []);
    assert.equal(c.head, seed.commit);
    assert.deepEqual(c.refs, ["refs/tags/seed-v2"]);
    assert.deepEqual(c.remotes, []);
    assert.equal(c.statusClean, true);
    const seedRefs = execFileSync("git", ["-C", seed.repo, "for-each-ref", "--format=%(refname)"]).toString();
    assert.equal(seedRefs, "refs/heads/main\nrefs/tags/seed-v2\n", "cloning leaves the seed's refs alone");
  });

  await check("a clone is refused on the wrong commit, an extra ref or a dirty tree", async () => {
    const work = path.join(tmp, "clone-bad");
    await cloneSeed(seedCfg(seed.repo), work, seed.commit);
    fs.writeFileSync(path.join(work, "stray.txt"), "x\n");
    execFileSync("git", ["-C", work, "branch", "stray"]);
    const { problems } = await inspectSeedClone(work, "seed-v2", "0".repeat(40));
    assert.equal(problems.length, 3, problems.join(" | "));
    assert.match(problems.join("\n"), /HEAD is/);
    assert.match(problems.join("\n"), /refs\/heads\/stray/);
    assert.match(problems.join("\n"), /stray\.txt/);
  });

  await check("prepare reads the manifests from the tag, not the seed's checkout", async () => {
    fs.writeFileSync(path.join(seed.repo, "package.json"), '{ "name": "edited-checkout" }\n');
    const out = path.join(tmp, "prepare-from-tag");
    fs.mkdirSync(out, { recursive: true });
    await writeSeedManifests(seedCfg(seed.repo), out);
    assert.equal(fs.readFileSync(path.join(out, "package.json"), "utf8"), '{ "name": "seed", "version": "1.0.0" }\n');
    execFileSync("git", ["-C", seed.repo, "checkout", "-q", "--", "package.json"]);
  });

  await check("preflight: the seed repository shape and the configured evaluator", async () => {
    const good = await seedRepoChecks(seedCfg(seed.repo));
    assert.deepEqual(good.map((c) => c.status), ["pass", "pass"], good.map((c) => c.detail).join(" | "));

    const other = fakeSeed("seed-v2-extra-ref");
    execFileSync("git", ["-C", other.repo, "branch", "stray"]);
    const extraRef = await seedRepoChecks(seedCfg(other.repo));
    assert.equal(extraRef[0]?.status, "fail");
    assert.match(extraRef[0]?.detail ?? "", /refs\/heads\/stray/);

    const twoCommits = fakeSeed("seed-v2-two-commits");
    fs.writeFileSync(path.join(twoCommits.repo, "src", "db.ts"), "export const db = 2;\n");
    execFileSync("git", ["-C", twoCommits.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "two"]);
    assert.equal((await seedRepoChecks(seedCfg(twoCommits.repo)))[0]?.status, "fail");

    const wrongVersion = await seedRepoChecks(seedCfg(seed.repo, { evaluatorVersion: "9.9.9" }));
    assert.equal(wrongVersion[1]?.status, "fail");
    const absent = await seedRepoChecks(seedCfg(seed.repo, { evaluatorDir: "no-such-evaluator" }));
    assert.equal(absent[1]?.status, "fail");
    assert.match(absent[1]?.detail ?? "", /missing package\.json/);
  });

  await check("a note surface the seed ships unchanged is no note; a changed or added one is", async () => {
    const work = path.join(tmp, "notes-clone");
    const cfg = seedCfg(seed.repo);
    await cloneSeed(cfg, work, seed.commit);
    const manifest = await buildManifest(cfg, work);
    assert.ok(manifest.noteSurfaces?.["CLAUDE.md"] !== undefined, "the manifest keeps the seed's note hashes");
    assert.equal(manifest.files["CLAUDE.md"], undefined, "and keeps them out of the hashed files");

    const untouched = noteSurfaceSources(work, seedNoteHashes(manifest));
    assert.deepEqual(untouched.sources, []);
    assert.deepEqual(untouched.unchanged, ["CLAUDE.md"]);
    const snap = takeSnapshot("C", path.join(tmp, "notes-snap-1"), untouched.sources, untouched.unchanged);
    assert.equal(snap.wroteNothingDurable, true, "an unchanged seed CLAUDE.md is not something phase A wrote");
    assert.deepEqual(snap.unchangedNoteSurfaces, ["CLAUDE.md"]);

    fs.appendFileSync(path.join(work, "CLAUDE.md"), "\nplanned work\n");
    fs.writeFileSync(path.join(work, "AGENTS.md"), "added by phase A\n");
    const written = noteSurfaceSources(work, seedNoteHashes(manifest));
    assert.deepEqual(written.sources.map((s2) => s2.relTarget), ["worktree/CLAUDE.md", "worktree/AGENTS.md"]);
    assert.deepEqual(written.unchanged, []);

    // A manifest from before the field existed falls back to the tag itself.
    const old = { ...manifest, noteSurfaces: undefined } as SeedManifest;
    assert.deepEqual(seedNoteHashes(old), manifest.noteSurfaces);
  });

  await check("harness overhead: the first call by start time, unknown usage counted apart", () => {
    const row = (ts: string, durationMs: number, usage: LedgerRow["usage"], phase = "B"): LedgerRow =>
      ({
        ts,
        durationMs,
        usage,
        phase,
        metered: true,
        attribution: "attributed",
      }) as LedgerRow;
    const u = (input: number, read: number, w5: number, w1: number, output = 999) => ({
      input,
      output,
      cacheRead: read,
      cacheWrite5m: w5,
      cacheWrite1h: w1,
      cacheWriteTierAssumed: false,
      raw: null,
    });
    const rows = [
      row("2026-10-04T10:00:00.500Z", 100, "unknown"),
      // Finished later but started first: it is the first call.
      row("2026-10-04T10:00:05.000Z", 4900, u(10, 1000, 200, 0)),
      row("2026-10-04T10:00:04.000Z", 1000, u(20, 3000, 0, 100)),
      row("2026-10-04T10:00:01.000Z", 10, u(1, 1, 1, 1), "A"),
      { ...row("2026-10-04T10:00:02.000Z", 10, u(5, 5, 5, 5)), attribution: "unattributed" } as LedgerRow,
    ];
    const b = harnessOverhead(rows, "B");
    assert.equal(b.firstCallPromptTokens, 1210, "input + cache read + both cache writes, never output");
    assert.equal(b.meanPromptTokens, Math.round((1210 + 3120) / 2));
    assert.equal(b.calls, 2);
    assert.equal(b.unknownCalls, 1);
    assert.equal(harnessOverhead(rows, "A").firstCallPromptTokens, 4);
    assert.deepEqual(harnessOverhead([], "A"), { calls: 0, unknownCalls: 0, firstCallPromptTokens: null, meanPromptTokens: null });
  });

  await check("an object-shaped evaluator error names its stage and cause; the outcome is unchanged", () => {
    const record = {
      attemptId: "T-2",
      phases: {},
      manifestCheckAfterA: { ok: true, changed: [], missing: [] },
    } as unknown as AttemptRecord;
    const message =
      "server exited before it was ready:\n> library-api@0.1.0 dev\n> tsx src/server.ts\n\n" +
      "node:events:502\n      throw er;\nError: listen EADDRINUSE: address already in use :::51562\n    at Server.setupListenHandle";
    const result = {
      completion: { holds: false, overdueFines: false, waive: false, nightly: false, seedTests: false },
      decisions: {},
      evaluatorError: { stage: "server-start", message },
    };
    const c = classify(record, result);
    assert.equal(c.outcome, "failure");
    assert.equal(c.failureCause, "completion");
    assert.equal(
      c.reason,
      "evaluator error at server-start: server exited before it was ready: Error: listen EADDRINUSE: address already in use :::51562",
    );
    const plain = classify(record, { ...result, evaluatorError: { stage: "db-init", message: "db:init failed\nmore" } });
    assert.equal(plain.reason, "evaluator error at db-init: db:init failed");
    const none = classify(record, { ...result, evaluatorError: null });
    assert.equal(none.reason, "one or more completion checks failed", "no error, the old reason");
    assert.equal(
      classify(record, { ...result, evaluatorError: "boom" }).reason,
      "evaluator did not reach a verdict: boom",
      "a string error reads as it always did",
    );
  });

}

/** The scratch script that set and cleared routing before `rig routing`, verbatim. */
const ROUTING_SCRIPT = `import json,sys
f,mode=sys.argv[1],sys.argv[2]
d=json.load(open(f))
e=d["providers"]["claude-code"]
ov=e.get("envOverrides") or {}
if isinstance(ov,list):
    ov=[x for x in ov if x.get("key")!="ANTHROPIC_BASE_URL"]
    if mode=="set": ov.append({"key":"ANTHROPIC_BASE_URL","value":"http://127.0.0.1:8787"})
else:
    ov.pop("ANTHROPIC_BASE_URL",None)
    if mode=="set": ov["ANTHROPIC_BASE_URL"]="http://127.0.0.1:8787"
e["envOverrides"]=ov
json.dump(d,open(f,"w"),indent=2); open(f,"a").write("\\n")
print("override",mode)
`;

function dryCfg(extra: Partial<BenchConfig> = {}): BenchConfig {
  return {
    ...loadConfig(path.join(rigRoot, "scripts", "dryrun.v3.json")),
    benchRoot: path.join(tmp, "dry-bench"),
    ...extra,
  };
}

/** The same config with no effort, no shared harness environment, no override keys and no phase-A reply rule. */
function bareCfg(cfg: BenchConfig): BenchConfig {
  const { effort: _effort, harnessEnv: _harnessEnv, phaseAReply: _phaseAReply, ...rest } = cfg;
  const { overrideEnv: _overrideEnv, selectionGuidePath: _guide, ...traycer } = cfg.traycer;
  return { ...rest, traycer };
}

function ledgerRow(phase: string, messageId: string | null, ts: string, input = 100): LedgerRow {
  return {
    ts,
    attemptId: "T-1",
    arm: "T",
    n: 1,
    phase,
    metered: true,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    stream: true,
    requestId: `req_${messageId ?? "none"}`,
    messageId,
    model: "claude-opus-5-5",
    clientMarker: `m_${messageId ?? "none"}`,
    retryCount: 0,
    auth: "bearer",
    attribution: "attributed",
    usage: { input, output: 10, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteTierAssumed: false, raw: null },
    durationMs: 1000,
  };
}

async function armTests(): Promise<void> {
  console.log("arms");

  await check("effort: both arms pass the configured level, and neither passes one when none is configured", async () => {
    const pinned = dryCfg();
    const unpinned = bareCfg(pinned);
    const c = claudeBaseArgs({ cfg: pinned });
    assert.deepEqual(c.slice(c.indexOf("--effort"), c.indexOf("--effort") + 2), ["--effort", "high"]);
    assert.equal(claudeBaseArgs({ cfg: unpinned }).includes("--effort"), false);
    const create = { epicId: "e", senderAgentId: "s", harness: "claude", model: "opus[1m]", cwd: "/w" };
    const t = createArgs({ ...create, reasoningEffort: "high" });
    assert.deepEqual(t.slice(t.indexOf("--reasoning-effort"), t.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);
    assert.equal(createArgs(create).includes("--reasoning-effort"), false);

    // The arm-T runner hands the config's level to `agent create`.
    const p = attemptPaths(pinned, "T", 1);
    fs.mkdirSync(p.work, { recursive: true });
    const cli = new DryRunTraycerCli("success", () => "");
    await runTraycer({
      cfg: pinned,
      paths: p,
      arm: "T",
      n: 1,
      phase: "B",
      prompt: "implement it",
      policy: { approval: "go ahead", question: "your call" },
      dryRun: true,
      proxyBaseUrl: "http://127.0.0.1:8787",
      apiKey: "",
      cli,
      epic: epicFor(pinned, 1),
      readChatOverride: async (_epicId, chatId) =>
        dryChat(chatId, "success", p.work, false, cli.turn, {
          senderAgentId: cli.senderAgentId,
          responseId: cli.lastResponseId,
          stamps: cli.turnStamps,
          phase: "B",
        }),
    });
    assert.equal(cli.created[0]?.reasoningEffort, "high");
  });

  const overridesFixture = (envOverrides: unknown): string => {
    const file = path.join(fs.mkdtempSync(path.join(tmp, "overrides-")), "provider-overrides.json");
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          providers: {
            "claude-code": { customPaths: [], selected: { kind: "bundled" }, apiKeyEnc: null, envOverrides, mode: "on", enabled: true },
            cursor: { envOverrides: {}, disabledBy: { handle: "zoë", at: 1784540133234 } },
          },
        },
        null,
        2,
      ) + "\n",
    );
    return file;
  };
  const withOverrides = (file: string, harnessEnv?: Record<string, string>): BenchConfig => {
    const base = bareCfg(dryCfg());
    return { ...base, ...(harnessEnv !== undefined ? { harnessEnv } : {}), traycer: { ...base.traycer, providerOverridesPath: file } };
  };

  await check("routing set and clear make the scratch script's writes, in both override shapes", () => {
    for (const shape of [{ ANTHROPIC_API_KEY_HINT: "x" }, [{ key: "OTHER", value: "1" }], null, []] as unknown[]) {
      for (const mode of ["set", "clear"] as const) {
        const ours = overridesFixture(shape);
        const theirs = overridesFixture(shape);
        if (mode === "clear") {
          writeRouting(withOverrides(ours), "set");
          execFileSync("python3", ["-c", ROUTING_SCRIPT, theirs, "set"]);
        }
        writeRouting(withOverrides(ours), mode);
        execFileSync("python3", ["-c", ROUTING_SCRIPT, theirs, mode]);
        assert.equal(fs.readFileSync(ours, "utf8"), fs.readFileSync(theirs, "utf8"), `${JSON.stringify(shape)} ${mode}`);
      }
    }

    // The extra keys go in beside the base URL and come out with it; nothing else moves.
    const file = overridesFixture({ KEEP: "me" });
    const cfg = withOverrides(file, { ENABLE_TOOL_SEARCH: "true" });
    writeRouting(cfg, "set");
    const set = JSON.parse(fs.readFileSync(file, "utf8")).providers["claude-code"].envOverrides;
    assert.deepEqual(set, { KEEP: "me", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ENABLE_TOOL_SEARCH: "true" });
    writeRouting(cfg, "clear");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).providers["claude-code"].envOverrides, { KEEP: "me" });

    // A chunk script calls the rig instead of editing the file itself.
    const cfgFile = path.join(path.dirname(file), "bench.json");
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    execFileSync(path.join(rigRoot, "bin", "rig"), ["routing", "set", "--config", cfgFile]);
    assert.equal(readProviderOverrides(cfg).routed, true);
    execFileSync(path.join(rigRoot, "bin", "rig"), ["routing", "clear", "--config", cfgFile]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).providers["claude-code"].envOverrides, { KEEP: "me" });
  });

  await check("overrides-check verifies every configured key; arm T is routed only when all of them match", () => {
    const file = overridesFixture({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" });
    const cfg = withOverrides(file, { ENABLE_TOOL_SEARCH: "true" });
    const half = readProviderOverrides(cfg);
    assert.equal(half.baseUrlMatches, true);
    assert.deepEqual(half.harnessEnv, [{ key: "ENABLE_TOOL_SEARCH", expected: "true", actual: null, matches: false }]);
    assert.equal(half.routed, false);
    assert.equal(readProviderOverrides(withOverrides(file)).routed, true, "no extra key configured: the base URL is enough");

    const cfgFile = path.join(path.dirname(file), "bench.json");
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const check1 = execFileSync(path.join(rigRoot, "bin", "rig"), ["overrides-check", "--config", cfgFile]).toString();
    assert.match(check1, /ENABLE_TOOL_SEARCH\s+\(unset\)\s+expected true\s+MISMATCH/);
    assert.match(check1, /PARTLY ROUTED/);

    writeRouting(cfg, "set");
    assert.equal(readProviderOverrides(cfg).routed, true);
    const check2 = execFileSync(path.join(rigRoot, "bin", "rig"), ["overrides-check", "--config", cfgFile]).toString();
    assert.match(check2, /ENABLE_TOOL_SEARCH\s+true\s+expected true\n/);
    assert.match(check2, /^ROUTED/m);
    assert.equal(readProviderOverrides(withOverrides(file, { ENABLE_TOOL_SEARCH: "auto" })).routed, false);
  });

  await check("one harness environment reaches arm C's spawn environment and arm T's routing; the rig's own keys win", () => {
    const shared = dryCfg();
    const ctx = (cfg: BenchConfig) =>
      ({ cfg, paths: attemptPaths(cfg, "C", 1), proxyBaseUrl: "http://127.0.0.1:8787", apiKey: "" }) as unknown as Parameters<typeof claudeEnv>[0];
    assert.equal(claudeEnv(ctx(shared))["ENABLE_TOOL_SEARCH"], "true");
    assert.equal(routingEnv(shared)["ENABLE_TOOL_SEARCH"], "true");
    const none = bareCfg(shared);
    assert.equal(claudeEnv(ctx(none))["ENABLE_TOOL_SEARCH"], undefined);
    assert.deepEqual(Object.keys(routingEnv(none)), ["ANTHROPIC_BASE_URL"]);
    const clash = { ...shared, harnessEnv: { ANTHROPIC_BASE_URL: "http://elsewhere", CLAUDE_CONFIG_DIR: "/x", FINE: "1" } };
    const e = claudeEnv(ctx(clash));
    assert.deepEqual([e["ANTHROPIC_BASE_URL"], e["CLAUDE_CONFIG_DIR"], e["FINE"]], ["http://127.0.0.1:8787", attemptPaths(clash, "C", 1).claudeConfig, "1"]);
    assert.deepEqual(reservedHarnessKeys(clash), ["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"]);
    assert.deepEqual(reservedHarnessKeys(shared), []);
  });

  await check("arm T's phase A sends the prompt alone when the prefix and ticket message are empty, both when set", async () => {
    const sends = async (base: BenchConfig, name: string): Promise<string[]> => {
      const cfg = { ...base, benchRoot: path.join(tmp, name) };
      const p = attemptPaths(cfg, "T", 1);
      fs.mkdirSync(p.work, { recursive: true });
      const cli = new DryRunTraycerCli("success", () => "");
      await runTraycer({
        cfg,
        paths: p,
        arm: "T",
        n: 1,
        phase: "A",
        prompt: "Think through the plan.",
        policy: { approval: "go ahead", question: "your call" },
        dryRun: true,
        proxyBaseUrl: "http://127.0.0.1:8787",
        apiKey: "",
        cli,
        epic: epicFor(cfg, 1),
        readChatOverride: async (_epicId, chatId) =>
          dryChat(chatId, "success", p.work, false, cli.turn, {
            senderAgentId: cli.senderAgentId,
            responseId: cli.lastResponseId,
            stamps: cli.turnStamps,
            phase: "A",
          }),
      });
      return cli.sent;
    };
    const plain = dryCfg();
    assert.deepEqual(await sends(plain, "msgs-plain"), ["Think through the plan."]);
    const prefixed = {
      ...plain,
      traycer: { ...plain.traycer, skillPrefixPhaseA: "/traycer-tech-plan", ticketBreakdownMessage: "Now break the plan into tickets." },
    };
    assert.deepEqual(await sends(prefixed, "msgs-prefixed"), ["/traycer-tech-plan Think through the plan.", "Now break the plan into tickets."]);
  });

  // The two lines the policy file holds, read rather than restated.
  const lines = approvalPolicy(dryCfg());

  await check("arm T: under phaseAReply a phase-A approval request gets the question line; phase B and a config without it keep the approval line", () => {
    const replies = (base: BenchConfig, name: string, phases: Phase[]): AttemptRecord => {
      const cfg = { ...base, benchRoot: path.join(tmp, name) };
      const cfgFile = path.join(tmp, `${name}.json`);
      fs.writeFileSync(cfgFile, JSON.stringify(cfg));
      const rig = (...args: string[]) =>
        execFileSync(path.join(rigRoot, "bin", "rig"), [...args, "T", "1", "--dry-run", "--scenario", "approval", "--config", cfgFile], { stdio: "pipe" });
      rig("new");
      for (const phase of phases) rig(phase === "A" ? "phase-a" : "phase-b");
      return readJson<AttemptRecord>(attemptPaths(cfg, "T", 1).record);
    };
    const sent = (r: AttemptRecord, phase: Phase) => r.phases[phase]?.scriptedReplies.map((x) => [x.kind, x.replyText]);
    const both = replies(v3Cfg("reply-t").cfg, "reply-t", ["A", "B"]);
    assert.deepEqual(sent(both, "A"), [["approval", lines.question]]);
    assert.deepEqual(sent(both, "B"), [["approval", lines.approval]]);
    const { phaseAReply: _rule, ...without } = v3Cfg("reply-t-without").cfg;
    assert.deepEqual(sent(replies(without, "reply-t-without", ["A"]), "A"), [["approval", lines.approval]]);
  });

  await check("arm C: under phaseAReply a phase-A approval request gets the question line; phase B and a config without it keep the approval line", async () => {
    // A stand-in binary: asks for approval, then finishes once resumed, and logs what it was sent.
    const fake = path.join(tmp, "fake-claude.sh");
    fs.writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'for last; do :; done',
        'printf "%s\\n" "$last" >> "$CLAUDE_CONFIG_DIR/../sent.log"',
        'case " $* " in',
        '  *" --resume "*) echo \'{"type":"result","result":"Done.","usage":{"input_tokens":1,"output_tokens":1}}\' ;;',
        '  *) echo \'{"type":"result","result":"The plan is written up. Shall I proceed with implementing it?","usage":{"input_tokens":1,"output_tokens":1}}\' ;;',
        "esac",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fake, 0o755);
    const run = async (base: BenchConfig, name: string, phase: Phase) => {
      const cfg = { ...base, benchRoot: path.join(tmp, name), claudeBinary: fake };
      const p = attemptPaths(cfg, "C", 1);
      fs.mkdirSync(p.work, { recursive: true });
      fs.mkdirSync(p.claudeConfig, { recursive: true });
      fs.mkdirSync(p.transcripts, { recursive: true });
      const record = await runClaude({
        cfg,
        paths: p,
        arm: "C",
        n: 1,
        phase,
        prompt: "Think through the plan.",
        policy: phasePolicy(cfg, phase),
        dryRun: false,
        proxyBaseUrl: "http://127.0.0.1:1",
        apiKey: "",
      });
      const log = fs.readFileSync(path.join(p.dir, "sent.log"), "utf8").trim().split("\n");
      fs.rmSync(path.join(p.dir, "sent.log"));
      return { replies: record.scriptedReplies.map((x) => [x.kind, x.replyText]), sent: log };
    };
    const { phaseAReply: _rule, ...without } = dryCfg();
    const a = await run(dryCfg(), "reply-c", "A");
    assert.deepEqual(a.replies, [["approval", lines.question]]);
    assert.deepEqual(a.sent, ["Think through the plan.", lines.question], "what the resumed session was sent");
    assert.deepEqual((await run(dryCfg(), "reply-c", "B")).replies, [["approval", lines.approval]]);
    assert.deepEqual((await run(without, "reply-c-without", "A")).replies, [["approval", lines.approval]]);
  });

}

console.log("rig selftest (no model calls)");
/** A user's guide as far as the tests know it: non-ASCII, a CRLF, and no newline at the end, so a lossy restore shows. */
const STAND_IN_GUIDE = Buffer.from("# Agent Selection Guide\n\nRoute by the nature of the task — Opus, Sol or Fable.\r\nno newline at the end", "utf8");

function v3Cfg(name: string): { cfg: BenchConfig; file: string } {
  const base = loadConfig(path.join(rigRoot, "scripts", "dryrun.v3.json"));
  const root = path.join(tmp, name);
  const fake = path.join(root, "fake-traycer");
  fs.mkdirSync(path.join(fake, "host", "config"), { recursive: true });
  const overrides = path.join(fake, "host", "config", "provider-overrides.json");
  fs.writeFileSync(
    overrides,
    JSON.stringify({ providers: { "claude-code": { customPaths: [], envOverrides: {}, mode: "on" }, codex: { envOverrides: {} } } }, null, 2) + "\n",
  );
  const guide = path.join(fake, "agent-selection-guide.md");
  fs.writeFileSync(guide, STAND_IN_GUIDE);
  const cfg: BenchConfig = {
    ...base,
    benchRoot: path.join(root, "bench"),
    traycer: { ...base.traycer, epicsRoot: path.join(fake, "epics"), providerOverridesPath: overrides, selectionGuidePath: guide },
  };
  const file = path.join(root, "bench.json");
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { cfg, file };
}

const rigBin = path.join(rigRoot, "bin", "rig");
function rigV3(file: string, ...args: string[]): string {
  return execFileSync(rigBin, [...args, "--config", file], { stdio: "pipe" }).toString();
}

/** A file's bytes one character per byte, so a comparison is byte for byte and still prints readably. */
function bytes(file: string): string {
  return fs.readFileSync(file).toString("latin1");
}

function overridesOf(cfg: BenchConfig): unknown {
  return JSON.parse(fs.readFileSync(cfg.traycer.providerOverridesPath, "utf8")).providers["claude-code"].envOverrides;
}

/** An assistant record as Claude Code 2.1.284 writes one, with only the fields the rig reads, plus a few it does not. */
function cc(sessionId: string, id: string, model: string, effort: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    sessionId,
    version: "2.1.284",
    effort,
    perTurnEffort: effort,
    requestId: `req_${id}`,
    ...extra,
    message: { id, model, role: "assistant", content: [{ type: "text", text: "sample" }], usage: { input_tokens: 1 } },
    timestamp: "2026-10-11T10:00:00.000Z",
  });
}

function v3Row(phase: string, messageId: string, model = "claude-opus-5-5", prompt = 1000): LedgerRow {
  return { ...ledgerRow(phase, messageId, "2026-10-11T10:00:00.000Z"), model, usage: { ...(ledgerRow(phase, messageId, "x").usage as Exclude<LedgerRow["usage"], "unknown">), input: 10, cacheRead: prompt - 10 } };
}

async function v3Tests(): Promise<void> {
  console.log("v3");

  await check("the v3 prompts are the plan and build texts around the frozen task and rules, byte for byte", () => {
    const task = fs.readFileSync(path.join(rigRoot, "evaluate", "texts", "task.txt"), "utf8").replace(/\n$/, "");
    const rules = fs.readFileSync(path.join(rigRoot, "evaluate", "texts", "rules.txt"), "utf8").replace(/\n$/, "");
    const plan =
      "Think through how we'd add these features to the library API. Here is what each one must do:\n\n" +
      `${task}\n\n` +
      "Work out the design decisions and write up the plan as tickets, one for each piece of work, in the order they should be built.\n\n" +
      "Rules that must hold:\n\n" +
      `${rules}\n\n` +
      "Don't build anything yet: don't modify any existing file except CLAUDE.md or AGENTS.md.\n";
    const build =
      "Now build all the tickets. Use whatever your environment offers for splitting the work across agents and reviewing it. Keep the existing tests passing.\n";
    // Line by line first, so a difference prints as the line it is in rather than a long truncated string.
    for (const [file, expected] of [["plan.txt", plan], ["build.txt", build]] as const) {
      const actual = fs.readFileSync(path.join(rigRoot, "prompts", file), "utf8");
      const a = actual.split("\n");
      const e = expected.split("\n");
      const at = e.findIndex((line, i) => a[i] !== line);
      if (at !== -1) assert.equal(a[at], e[at], `${file} line ${at + 1}`);
      assert.equal(actual, expected, file);
    }
    const cfg = loadConfig(path.join(rigRoot, "bench.example.json"));
    assert.deepEqual(cfg.prompts, { phaseA: "prompts/plan.txt", phaseB: "prompts/build.txt", approvalPolicy: "prompts/approval-policy.txt" });
  });

  await check("bench.example.json: protocol v3, a bench root and seed repo inside the repo, seed v2, evaluator 3.0.0, every switch, one epic per attempt", () => {
    const cfg = loadConfig(path.join(rigRoot, "bench.example.json"));
    assert.deepEqual(
      {
        protocol: cfg.protocol,
        benchRoot: cfg.benchRoot,
        seed: [cfg.seedRepoPath, cfg.seedTag],
        k: cfg.k,
        evaluator: [cfg.evaluatorDir, cfg.evaluatorVersion, cfg.evaluatorCommand.join(" ")],
        effort: cfg.effort,
        attributeCalls: cfg.attributeCalls,
        retireAgents: cfg.traycer.retireAgents,
        phaseAReply: cfg.phaseAReply,
        guide: cfg.traycer.selectionGuidePath,
        overrides: cfg.traycer.providerOverridesPath,
        modelRef: cfg.model.armModelRef,
      },
      {
        protocol: "v3",
        benchRoot: path.join(rigRoot, "runs"),
        seed: [path.join(rigRoot, ".seed-repo"), "seed-v2"],
        k: 5,
        evaluator: ["evaluate", "3.0.0", "npm --prefix evaluate run --silent evaluate --"],
        effort: "high",
        attributeCalls: true,
        retireAgents: true,
        phaseAReply: "question",
        guide: path.join(os.homedir(), ".traycer", "agent-selection-guide.md"),
        overrides: path.join(os.homedir(), ".traycer", "host", "config", "provider-overrides.json"),
        modelRef: { C: "opus[1m]", T: "opus[1m]" },
      },
    );
    assert.deepEqual(v3EpicMappingProblems(cfg), []);
    assert.deepEqual(Object.keys(cfg.traycer.attempts), ["1", "2", "3", "4", "5"]);
    assert.throws(() => epicFor(cfg, 1), /traycer\.attempts\["1"\]\.epic is not set/, "a placeholder is never run");
    const id = (seedChar: string) => `${seedChar.repeat(8)}-0000-4000-8000-000000000000`;
    const withMapping = (smoke: Record<string, string | null>, attempts: Record<string, Record<string, string | null>>) =>
      ({ ...cfg, k: 3, traycer: { ...cfg.traycer, smoke, attempts } }) as unknown as BenchConfig;
    const unmapped = { epic: null, sender: null };
    assert.deepEqual(v3EpicMappingProblems(withMapping(unmapped, {})), []);
    const mapped = {
      "1": { epic: id("1"), sender: id("2") },
      "2": { epic: id("3"), sender: id("4") },
      "3": { epic: id("5"), sender: id("6") },
    };
    assert.deepEqual(v3EpicMappingProblems(withMapping({ epic: id("a"), sender: id("b") }, mapped)), []);
    assert.deepEqual(v3EpicMappingProblems(withMapping({ epic: id("a"), sender: null }, {})), ["smoke: partly mapped"]);
    assert.deepEqual(v3EpicMappingProblems(withMapping(unmapped, { "1": { epic: id("a") } })), ["1: keys epic"]);
    assert.deepEqual(v3EpicMappingProblems(withMapping({ epic: id("a"), sender: id("b") }, { "1": { epic: id("c"), sender: id("a") } })), [
      `${id("a")} appears 2 times`,
    ]);
    for (const key of ["0", "4", "01", "x"]) {
      assert.deepEqual(v3EpicMappingProblems(withMapping(unmapped, { [key]: { epic: null, sender: null } })), [
        `attempt ${key} is outside 1 to 3`,
      ]);
    }
    assert.deepEqual(cfg.harnessEnv, { ENABLE_TOOL_SEARCH: "true", CLAUDE_CODE_SUBAGENT_MODEL: "opus[1m]", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    assert.deepEqual(cfg.traycer.overrideEnv, { ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
    assert.equal(readJson<{ version: string }>(path.join(rigRoot, "evaluate", "package.json")).version, cfg.evaluatorVersion);
    // The turn limits reach the places the arms read them; a config without them is left as it is.
    const limits = (ph: Phase): number[] => {
      const c = phaseConfig(cfg, ph);
      return [c.phaseTimeoutMs, c.maxScriptedReplies, c.traycer.maxScriptedReplies];
    };
    assert.deepEqual({ A: limits("A"), B: limits("B") }, { A: [45 * 60_000, 3, 5], B: [120 * 60_000, 10, 10] });
    const unlimited = { ...cfg, phaseLimits: undefined };
    assert.equal(phaseConfig(unlimited, "B"), unlimited);
  });

  await check("arm C gets the subagent pin in its own environment; only arm T's override gets the connector switch", () => {
    const cfg = loadConfig(path.join(rigRoot, "bench.example.json"));
    const p = attemptPaths({ ...cfg, benchRoot: path.join(tmp, "v3-env") }, "C", 1);
    const env = claudeEnv({ cfg, paths: p, arm: "C", n: 1, phase: "B", prompt: "", policy: { approval: "", question: "" }, dryRun: true, proxyBaseUrl: "http://127.0.0.1:8787", apiKey: "" });
    assert.deepEqual(
      [env["CLAUDE_CODE_SUBAGENT_MODEL"], env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"], env["ENABLE_CLAUDEAI_MCP_SERVERS"]],
      ["opus[1m]", "1", undefined],
    );
    assert.deepEqual(Object.keys(routingEnv(cfg)), [
      "ANTHROPIC_BASE_URL",
      "ENABLE_TOOL_SEARCH",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
      "ENABLE_CLAUDEAI_MCP_SERVERS",
    ]);
    assert.deepEqual(Object.keys(routingEnv({ ...bareCfg(cfg), harnessEnv: { ENABLE_TOOL_SEARCH: "true" } })), ["ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH"]);
  });

  await check("the window sets every switch and the bench guide, and clear restores the guide byte for byte and the override to {}", () => {
    const { cfg, file } = v3Cfg("v3-window");
    const before = overridesOf(cfg);
    const opened = openWindow(cfg);
    assert.deepEqual(overridesOf(cfg), {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ENABLE_TOOL_SEARCH: "true",
      CLAUDE_CODE_SUBAGENT_MODEL: "opus[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
    const guide = cfg.traycer.selectionGuidePath as string;
    assert.equal(
      fs.readFileSync(guide, "utf8"),
      "Every agent, the coordinator and every child it creates, runs on the `claude` harness with model `opus[1m]` at `high` reasoning effort.\n",
    );
    assert.equal(benchGuide(cfg).split("\n").length, 2, "one line");
    assert.equal(bytes(windowPaths(cfg).backup), STAND_IN_GUIDE.toString("latin1"));
    assert.equal(opened.record.originalBytes, STAND_IN_GUIDE.length);
    assert.equal(windowState(cfg).routed, true);
    assert.throws(() => openWindow(cfg), /a backup from an earlier window is still present/);

    const closed = closeWindow(cfg);
    assert.equal(bytes(guide), STAND_IN_GUIDE.toString("latin1"), "the guide is not byte for byte what it was");
    assert.equal(closed.restored?.verified, true);
    assert.deepEqual(overridesOf(cfg), before);
    assert.deepEqual(overridesOf(cfg), {});
    assert.deepEqual(
      [windowState(cfg).open, fs.existsSync(windowPaths(cfg).backup)],
      [false, false],
      "the window is still open after clear",
    );

    // The chunk script's path: the rig itself, then its trap's `clear`, which is safe to repeat.
    rigV3(file, "routing", "set");
    assert.equal(windowState(cfg).guideIsBench, true);
    rigV3(file, "routing", "clear");
    rigV3(file, "routing", "clear");
    assert.equal(bytes(guide), STAND_IN_GUIDE.toString("latin1"));
    assert.deepEqual(overridesOf(cfg), {});

    // A key the config drops while a window is open still comes out with the window.
    openWindow(cfg);
    const dropped: BenchConfig = { ...cfg, traycer: { ...cfg.traycer, overrideEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } } };
    closeWindow(dropped);
    assert.deepEqual(overridesOf(cfg), {});
  });

  await check("after a crash at any step of `set`, a second `set` refuses and `clear` restores the guide byte for byte", () => {
    for (const step of ["backup", "override", "guide"] as const) {
      const { cfg, file } = v3Cfg(`v3-crash-${step}`);
      assert.throws(
        () =>
          openWindow(cfg, {
            afterStep: (s2) => {
              if (s2 === step) throw new Error(`simulated crash after ${s2}`);
            },
          }),
        /simulated crash/,
      );
      const refused = spawnSync(rigBin, ["routing", "set", "--config", file], { encoding: "utf8" });
      assert.equal(refused.status, 1, `set after a crash at ${step}`);
      assert.match(refused.stderr, /a backup from an earlier window is still present/);
      const cleared = spawnSync(rigBin, ["routing", "clear", "--config", file], { encoding: "utf8" });
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(bytes(cfg.traycer.selectionGuidePath as string), STAND_IN_GUIDE.toString("latin1"), `guide after a crash at ${step}`);
      assert.deepEqual(overridesOf(cfg), {}, `override after a crash at ${step}`);
      assert.equal(windowState(cfg).open, false);
    }
  });

  await check("preflight fails on an override or a guide left behind outside a window, and passes once both are back", () => {
    const { cfg } = v3Cfg("v3-preflight");
    const status = (): Record<string, string> =>
      Object.fromEntries(equalSetupChecks(cfg).filter((c) => c.name.startsWith("no attempt running")).map((c) => [c.name, c.status]));
    const OVERRIDE = "no attempt running: the provider override is {}";
    const GUIDE = "no attempt running: the selection guide is the user's own";
    assert.deepEqual(status(), { [OVERRIDE]: "pass", [GUIDE]: "ready" }, "before any window");
    openWindow(cfg);
    assert.deepEqual(status(), {}, "inside a window the leftover checks give way to the window check");
    closeWindow(cfg);
    assert.deepEqual(status(), { [OVERRIDE]: "pass", [GUIDE]: "pass" });

    // An override key left behind.
    const file = cfg.traycer.providerOverridesPath;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.providers["claude-code"].envOverrides = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    assert.deepEqual(status(), { [OVERRIDE]: "fail", [GUIDE]: "pass" });
    data.providers["claude-code"].envOverrides = {};
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

    // The bench guide left in place with no backup, then a guide that differs from the recorded original.
    const guide = cfg.traycer.selectionGuidePath as string;
    fs.writeFileSync(guide, benchGuide(cfg));
    assert.deepEqual(status(), { [OVERRIDE]: "pass", [GUIDE]: "fail" });
    fs.writeFileSync(guide, Buffer.concat([STAND_IN_GUIDE, Buffer.from(" ")]));
    assert.deepEqual(status(), { [OVERRIDE]: "pass", [GUIDE]: "fail" });
    fs.writeFileSync(guide, STAND_IN_GUIDE);
    assert.deepEqual(status(), { [OVERRIDE]: "pass", [GUIDE]: "pass" });
  });

  await check("retirement stops then archives every agent in the epic, deepest first, and the sender last", async () => {
    const agent = (id: string, parentId: string | null) => ({ id, parentId, active: false, harnessId: "claude", surface: "gui", title: id, isSelf: false });
    const cli = new DryRunTraycerCli("success", () => "");
    cli.adopt("coord");
    cli.descendants.push(agent("c-b", "coord"), agent("c-a", "coord"), agent("g-1", "c-a"), agent("stray", null));
    cli.refuseArchives = 1;
    const retired = await retireEpic(cli, "epic", "sender", "coord", { retryMs: 1 });
    assert.deepEqual(
      cli.manageCalls.map((c) => `${c.action} ${c.targetId} as ${c.actingAs}`),
      [
        "stop g-1 as sender",
        "stop c-a as sender",
        "stop c-b as sender",
        "stop coord as sender",
        "stop stray as sender",
        "stop sender as coord",
        "archive g-1 as g-1",
        "archive g-1 as g-1",
        "archive c-a as c-a",
        "archive c-b as c-b",
        "archive coord as coord",
        "archive stray as stray",
        "archive sender as sender",
      ],
    );
    assert.deepEqual(
      retired.steps.filter((s2) => s2.action === "stop").map((s2) => [s2.agentId, s2.agent, s2.depth ?? null]),
      [
        ["g-1", "descendant", 2],
        ["c-a", "descendant", 1],
        ["c-b", "descendant", 1],
        ["coord", "child", 0],
        ["stray", "descendant", -1],
        ["sender", "sender", null],
      ],
    );
    assert.equal(retired.allOk, true);
    assert.deepEqual([...depthsBelow([{ id: "x", parentId: "y" }, { id: "y", parentId: "x" }], "r").values()], [-1, -1], "a cycle ends");
  });

  await check("the dry runs: the build turn goes to the plan turn's coordinator, and arm C resumes its one session", () => {
    const { cfg, file } = v3Cfg("v3-turns");
    rigV3(file, "new", "T", "1", "--dry-run");
    const early = spawnSync(rigBin, ["phase-b", "T", "1", "--dry-run", "--config", file], { encoding: "utf8" });
    assert.equal(early.status, 1);
    assert.match(early.stderr, /has no plan turn yet/);
    rigV3(file, "phase-a", "T", "1", "--dry-run");
    rigV3(file, "phase-b", "T", "1", "--dry-run");
    const t = readJson<AttemptRecord>(attemptPaths(cfg, "T", 1).record);
    const a = t.phases.A?.traycer;
    const b = t.phases.B?.traycer;
    assert.deepEqual(
      { protocol: t.protocol, epics: [a?.epicId, b?.epicId], coordinator: b?.childAgentId, reused: b?.reusedCoordinator, hash: t.manifestCheckAfterA?.ok },
      { protocol: "v3", epics: ["DRYRUN-EPIC-0001", "DRYRUN-EPIC-0001"], coordinator: a?.childAgentId, reused: true, hash: true },
    );
    assert.deepEqual(
      (t.roster ?? []).map((r) => [r.depth, r.parentId === a?.childAgentId || r.depth === 0]),
      [[0, true], [1, true], [1, true]],
    );

    rigV3(file, "new", "C", "1", "--dry-run");
    rigV3(file, "phase-a", "C", "1", "--dry-run");
    rigV3(file, "phase-b", "C", "1", "--dry-run");
    const c = readJson<AttemptRecord>(attemptPaths(cfg, "C", 1).record);
    const flagFor = (cmd: string[]): string[] => {
      const i = cmd.findIndex((x) => x === "--session-id" || x === "--resume");
      return cmd.slice(i, i + 2);
    };
    const sid = c.phases.A?.sessionId ?? "";
    assert.deepEqual(
      { a: flagFor(c.phases.A?.harnessCommand ?? []), b: flagFor(c.phases.B?.harnessCommand ?? []), sameSession: c.phases.B?.sessionId === sid },
      { a: ["--session-id", sid], b: ["--resume", sid], sameSession: true },
    );
    // The plan turn's session file is still where Claude Code wrote it: nothing removed it.
    assert.equal(walk(attemptPaths(cfg, "C", 1).claudeConfig).some((f) => f.endsWith(`${sid}.jsonl`)), true);
  });

  await check("a plan turn that changes a hashed seed file is a planViolation", () => {
    const { cfg, file } = v3Cfg("v3-violation");
    rigV3(file, "new", "T", "1", "--dry-run");
    rigV3(file, "phase-a", "T", "1", "--dry-run", "--scenario", "plan-violation");
    rigV3(file, "classify", "T", "1", "--dry-run");
    const record = readJson<AttemptRecord>(attemptPaths(cfg, "T", 1).record);
    assert.deepEqual(
      [record.classification?.outcome, record.classification?.failureCause, record.manifestCheckAfterA?.changed],
      ["failure", "planViolation", ["src/routes/loans.ts"]],
    );
  });

  // Claude Code 2.1.284's layout, built here to match it: `<project>/<session>.jsonl`, and each
  // subagent beside it under `<session>/subagents/`, sometimes one folder deeper, with a meta file.
  const sampleSession = (configDir: string, projectDir: string, sid: string): void => {
    const project = path.join(configDir, "projects", projectDir);
    fs.mkdirSync(path.join(project, sid, "subagents", "workflows", "wf-1"), { recursive: true });
    fs.writeFileSync(
      path.join(project, `${sid}.jsonl`),
      [
        JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "plan" } }),
        cc(sid, "m-main-1", "claude-opus-5-5", "high"),
        cc(sid, "m-main-err", "<synthetic>", "high"),
      ].join("\n") + "\n",
    );
    const sub = path.join(project, sid, "subagents");
    fs.writeFileSync(path.join(sub, "agent-a11.jsonl"), cc(sid, "m-sub-1", "claude-opus-5-5", "high", { isSidechain: true, agentId: "a11" }) + "\n");
    fs.writeFileSync(path.join(sub, "agent-a11.meta.json"), JSON.stringify({ agentType: "Explore", description: "Map the routes", spawnDepth: 1 }));
    fs.writeFileSync(
      path.join(sub, "workflows", "wf-1", "agent-a22.jsonl"),
      cc(sid, "m-sub-2", "claude-opus-5-5", "high", { isSidechain: true, agentId: "a22" }) + "\n",
    );
    fs.writeFileSync(path.join(sub, "workflows", "wf-1", "agent-a22.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Review" }));
  };

  await check("subagent transcripts are found beside their session, nested folders included, and copied with their meta", () => {
    const configDir = path.join(tmp, "v3-layout", "claude");
    const worktree = path.join(tmp, "v3-layout", "work");
    sampleSession(configDir, worktree.replace(/\//g, "-"), "sess-1");
    // An agent in a worktree of its own writes under another project folder.
    sampleSession(configDir, "-elsewhere-worktree", "sess-2");
    const dest = path.join(tmp, "v3-layout", "sessions");
    const roster = (id: string, sessions: string[]): RosterEntry => ({
      agentId: id, parentId: null, depth: 0, title: id, harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high",
      claudeSessionIds: sessions, nativeUsd: null, settingsFrom: "stub",
    });
    const missing = collectSessions([roster("agent-1", ["sess-1", "sess-gone"]), roster("agent-2", ["sess-2"])], configDir, worktree, dest);
    assert.deepEqual(missing, ["sess-gone"]);
    assert.deepEqual(walk(dest).map((f) => path.relative(dest, f)), [
      "agent-1/sess-1.jsonl",
      "agent-1/sess-1/subagents/agent-a11.jsonl",
      "agent-1/sess-1/subagents/agent-a11.meta.json",
      "agent-1/sess-1/subagents/workflows/wf-1/agent-a22.jsonl",
      "agent-1/sess-1/subagents/workflows/wf-1/agent-a22.meta.json",
      "agent-2/sess-2.jsonl",
      "agent-2/sess-2/subagents/agent-a11.jsonl",
      "agent-2/sess-2/subagents/agent-a11.meta.json",
      "agent-2/sess-2/subagents/workflows/wf-1/agent-a22.jsonl",
      "agent-2/sess-2/subagents/workflows/wf-1/agent-a22.meta.json",
    ]);
    assert.deepEqual(
      subagentFilesUnder(path.join(dest, "agent-1", "sess-1", "subagents")).map((s2) => [s2.agentId, s2.agentType, s2.description, s2.spawnDepth]),
      [["a11", "Explore", "Map the routes", 1], ["a22", "general-purpose", "Review", null]],
    );
    const main = readAgentRecords(path.join(dest, "agent-1", "sess-1.jsonl"));
    assert.deepEqual([[...main.messageIds], main.models, main.efforts], [["m-main-1", "m-main-err"], ["claude-opus-5-5"], ["high"]]);

    // Arm C keeps the same tree beside its transcript.
    const archived = path.join(tmp, "v3-layout", "phase-b.subagents");
    archiveSubagentTree(configDir, "sess-1", archived);
    assert.deepEqual(walk(archived).map((f) => path.relative(archived, f)), [
      "agent-a11.jsonl",
      "agent-a11.meta.json",
      "workflows/wf-1/agent-a22.jsonl",
      "workflows/wf-1/agent-a22.meta.json",
    ]);
  });

  await check("every session of every agent in the coordinator's subtree is the attempt's own; anything else is foreign", () => {
    const { cfg } = v3Cfg("v3-attribution");
    const p = attemptPaths(cfg, "T", 1);
    const write = (agentId: string, sid: string, ids: string[], subagent?: string[]): void => {
      const dir = path.join(sessionsDir(p), agentId);
      fs.mkdirSync(path.join(dir, sid, "subagents"), { recursive: true });
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), ids.map((id) => cc(sid, id, "claude-opus-5-5", "high")).join("\n") + "\n");
      if (subagent !== undefined) {
        fs.writeFileSync(path.join(dir, sid, "subagents", "agent-s1.jsonl"), subagent.map((id) => cc(sid, id, "claude-opus-5-5", "high", { isSidechain: true })).join("\n") + "\n");
      }
    };
    // The coordinator ran in two Claude sessions; one child has a subagent; one agent sits outside the subtree.
    write("coord", "s-c1", ["m1"]);
    write("coord", "s-c2", ["m2"]);
    write("child", "s-k", ["m3"], ["m4"]);
    write("stray", "s-x", ["m5"]);
    const entry = (agentId: string, parentId: string | null, depth: number, sessions: string[]): RosterEntry => ({
      agentId, parentId, depth, title: agentId, harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high",
      claudeSessionIds: sessions, nativeUsd: null, settingsFrom: "stub",
    });
    const record = {
      attemptId: "T-1", arm: "T", n: 1, phases: {},
      roster: [entry("coord", "sender", 0, ["s-c1", "s-c2"]), entry("child", "coord", 1, ["s-k"]), entry("stray", null, -1, ["s-x"])],
    } as unknown as AttemptRecord;
    const agents = attemptAgents(cfg, record, p);
    assert.deepEqual(agents.map((a) => [a.agentId, a.kind, a.depth, a.files.length]), [
      ["coord", "coordinator", 0, 2],
      ["child", "child", 1, 1],
      ["s1", "subagent", 2, 1],
    ]);
    const rows = [v3Row("A", "m1"), v3Row("B", "m2"), v3Row("B", "m3"), v3Row("B", "m4"), v3Row("B", "m5"), v3Row("B", "m6")];
    const attribution = attributeCalls(rows, "B", phaseSessionsOf(agents, "T"), prices);
    assert.deepEqual(
      [attribution.calls, attribution.matched, attribution.foreign.map((f) => [f.messageId, f.belongsTo])],
      [5, 3, [["m5", "noSession"], ["m6", "noSession"]]],
    );
    const measured = measureAgents(cfg, agents, rows);
    assert.deepEqual(measured.agents.map((a) => [a.agentId, a.calls]), [
      ["coord", { A: 1, B: 1 }],
      ["child", { B: 1 }],
      ["s1", { B: 1 }],
    ]);
    assert.deepEqual(
      measured.sessionCalls.map((sc) => [sc.agentId, sc.sessionId, sc.phase, sc.calls]),
      [["coord", "s-c1", "A", 1], ["coord", "s-c2", "B", 1], ["child", "s-k", "B", 1], ["s1", "s1", "B", 1]],
    );
    assert.deepEqual([turnEffort(agents, rows, "A", "high").records, turnEffort(agents, rows, "B", "high").records], [1, 3]);
  });

  await check("an agent off the pinned model or effort, by any of five signs, excludes the attempt as modelMismatch", () => {
    const { cfg } = v3Cfg("v3-mismatch");
    const dir = path.join(tmp, "v3-mismatch", "files");
    fs.mkdirSync(dir, { recursive: true });
    const agentFile = (name: string, model: string, effort: string): string => {
      const f = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(f, cc(name, `m-${name}`, model, effort) + "\n");
      return f;
    };
    const base = { kind: "child" as const, parentId: "coord", depth: 1, title: null, sessionIds: [] };
    const agents = [
      { ...base, agentId: "on", harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", files: [{ sessionId: "on", file: agentFile("on", "claude-opus-5-5", "high") }] },
      { ...base, agentId: "harness", harness: "codex", configuredModel: "gpt", configuredEffort: "high", files: [] },
      { ...base, agentId: "configured", harness: "claude", configuredModel: "sonnet", configuredEffort: "medium", files: [{ sessionId: "configured", file: agentFile("configured", "claude-opus-5-5", "high") }] },
      { ...base, agentId: "recorded", harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", files: [{ sessionId: "recorded", file: agentFile("recorded", "claude-haiku-5-5", "high") }] },
      { ...base, agentId: "resolved", harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", files: [{ sessionId: "resolved", file: agentFile("resolved", "claude-opus-5-5", "high") }] },
      { ...base, agentId: "effort", kind: "subagent" as const, harness: "claude", configuredModel: null, configuredEffort: null, files: [{ sessionId: "effort", file: agentFile("effort", "claude-opus-5-5", "low") }] },
    ];
    const rows = [v3Row("B", "m-on"), v3Row("B", "m-configured"), v3Row("B", "m-recorded", "claude-haiku-5-5"), v3Row("B", "m-resolved", "claude-sonnet-5-5"), v3Row("B", "m-effort")];
    const m = measureAgents(cfg, agents, rows);
    assert.deepEqual(m.check.mismatched, [
      { agentId: "harness", reasons: ["harness codex", "configured model gpt"] },
      { agentId: "configured", reasons: ["configured model sonnet", "configured effort medium"] },
      { agentId: "recorded", reasons: ["recorded model claude-haiku-5-5", "resolved model claude-haiku-5-5"] },
      { agentId: "resolved", reasons: ["resolved model claude-sonnet-5-5"] },
      { agentId: "effort", reasons: ["effort low"] },
    ]);
    const record = { attemptId: "T-1", arm: "T", n: 1, phases: {}, manifestCheckAfterA: null, agentCheck: m.check } as unknown as AttemptRecord;
    assert.deepEqual(
      [classify(record, null).outcome, classify(record, null).exclusionCause],
      ["infrastructureExcluded", "modelMismatch"],
    );
    const clean = measureAgents(cfg, agents.slice(0, 1), rows);
    assert.deepEqual([clean.check.mismatched, classify({ ...record, agentCheck: clean.check }, null).exclusionCause], [[], null]);
  });

  await check("the build turn settles once the coordinator has replied and its whole subtree is idle; the timeout still caps it", async () => {
    const base = loadConfig(path.join(rigRoot, "scripts", "dryrun.v3.json"));
    const kid = { id: "kid", parentId: "coord", active: false, harnessId: "claude", surface: "gui", title: "kid", isSelf: false };
    const turn = async (activeFor: number, timeoutMs: number): Promise<{ record: PhaseRecord; cli: DryRunTraycerCli }> => {
      const cfg: BenchConfig = {
        ...base,
        benchRoot: path.join(tmp, `v3-settle-${activeFor}`),
        phaseTimeoutMs: timeoutMs,
        traycer: { ...base.traycer, pollIntervalMs: 5 },
      };
      const p = attemptPaths(cfg, "T", 1);
      fs.mkdirSync(p.work, { recursive: true });
      const cli = new DryRunTraycerCli("success", () => "");
      cli.adopt("coord");
      cli.descendants.push(kid);
      cli.activeFor.set("kid", activeFor);
      const record = await runTraycer({
        cfg, paths: p, arm: "T", n: 1, phase: "B", prompt: "Now build all the tickets.",
        policy: { approval: "approved", question: "your call" }, dryRun: true, proxyBaseUrl: "http://127.0.0.1:8787", apiKey: "",
        cli, coordinatorId: "coord", epic: { epicId: "E", senderAgentId: "S" }, waitForSubtree: true,
        readChatOverride: async (_epicId, chatId) =>
          dryChat(chatId, "success", p.work, false, cli.turn, { senderAgentId: cli.senderAgentId, responseId: cli.lastResponseId, stamps: cli.turnStamps, phase: "B" }),
      });
      return { record, cli };
    };
    // The coordinator has replied by the first poll, while its child works for four more.
    const late = await turn(4, 60_000);
    const settle = late.record.traycer?.settles?.[0];
    assert.deepEqual(
      {
        completedBy: late.record.traycer?.completedBy,
        activeAtSettle: late.record.traycer?.activeAtSettle,
        settledOn: settle?.kind,
        polls: settle?.polls,
        heldOpenAfterReply: settle?.pollsHeldOpenAfterReply,
        replied: settle?.firstReplyAt !== null,
        settledOnceIdle: Date.parse(late.record.settledAt) >= Date.parse(settle?.settledAt ?? ""),
      },
      { completedBy: "reply", activeAtSettle: [], settledOn: "reply", polls: 6, heldOpenAfterReply: 5, replied: true, settledOnceIdle: true },
    );

    // A child that never goes idle runs the turn into its timeout, which stops the subtree.
    const stuck = await turn(1_000_000, 300);
    assert.deepEqual(
      [stuck.record.traycer?.completedBy, stuck.record.timedOut, stuck.cli.stopCalls],
      ["timeout", true, [{ childId: "coord", cascade: true }]],
    );
  });

  await check("arm C's audit reads the session and every subagent transcript; a subagent's read outside the roots is flagged and named", () => {
    // Arm C: the session spans both turns and a subagent sits beside it; each read is put in the turn it was made in.
    const { cfg } = v3Cfg("v3-audit-c");
    const p = attemptPaths(cfg, "C", 1);
    fs.mkdirSync(path.join(p.transcripts, "phase-b.subagents"), { recursive: true });
    fs.mkdirSync(p.work, { recursive: true });
    const read = (sid: string, id: string, file: string, at: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        type: "assistant", sessionId: sid, effort: "high", timestamp: at, ...extra,
        message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: `t_${id}`, name: "Read", input: { file_path: file } }] },
      });
    const main = path.join(p.transcripts, "phase-b.jsonl");
    fs.writeFileSync(
      main,
      [read("sid-c", "m1", path.join(p.work, "src", "app.ts"), "2026-10-11T10:00:00.000Z"), read("sid-c", "m2", "/etc/passwd", "2026-10-11T10:00:01.000Z")].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(p.transcripts, "phase-b.subagents", "agent-sub9.jsonl"),
      read("sid-c", "m3", "/etc/hosts", "2026-10-11T11:30:00.000Z", { isSidechain: true, agentId: "sub9" }) + "\n",
    );
    const record = {
      attemptId: "C-1", arm: "C", n: 1, phases: {
        A: { sessionId: "sid-c", transcriptPath: path.join(p.transcripts, "phase-a.jsonl"), launchedAt: "2026-10-11T09:59:00.000Z" },
        B: { sessionId: "sid-c", transcriptPath: main, launchedAt: "2026-10-11T11:00:00.000Z" },
      },
    } as unknown as AttemptRecord;
    const c = auditTranscripts("C-1", { A: [p.work], B: [p.work] }, auditTranscriptsV3(cfg, record, p, new Map()));
    assert.deepEqual(
      c.offendingPaths.map((o) => [o.phase, o.path, o.source]),
      [
        ["A", "/etc/passwd", "session sid-c"],
        ["B", "/etc/hosts", "subagent sub9 of session sid-c"],
      ],
    );
  });

  await check("arm T's audit reads every agent's chat and Claude sessions; a child's read outside the roots is flagged and named", () => {
    // A child of the stand-in coordinator reads outside the roots during the build.
    const t = v3Cfg("v3-audit-t");
    rigV3(t.file, "new", "T", "1", "--dry-run");
    rigV3(t.file, "phase-a", "T", "1", "--dry-run");
    execFileSync(rigBin, ["phase-b", "T", "1", "--dry-run", "--config", t.file], { stdio: "pipe", env: { ...process.env, RIG_DRYRUN_AUDIT_DIRTY: "child" } });
    const audit = JSON.parse(rigV3(t.file, "audit", "T", "1", "--dry-run")) as AuditRecord;
    const roster = readJson<AttemptRecord>(attemptPaths(t.cfg, "T", 1).record).roster ?? [];
    const child = roster.find((r) => r.depth === 1 && r.title === "ticket 1 builder");
    assert.deepEqual(
      audit.offendingPaths.map((o) => [o.phase, o.path, o.source]),
      [["B", "/etc/hosts", `child ${child?.agentId} (parent ${child?.parentId}), session ${child?.claudeSessionIds[0]}`]],
    );
  });

  await check("the wrong-model dry run is excluded, and the v3 report renders every v3 section", () => {
    const { cfg, file } = v3Cfg("v3-turns");
    rigV3(file, "new", "T", "2", "--dry-run");
    rigV3(file, "phase-a", "T", "2", "--dry-run");
    rigV3(file, "phase-b", "T", "2", "--dry-run", "--scenario", "wrong-model");
    for (const [arm, n] of [["T", "1"], ["T", "2"], ["C", "1"]] as const) {
      rigV3(file, "ledger", arm, n, "--dry-run");
      rigV3(file, "measure", arm, n, "--dry-run");
      rigV3(file, "classify", arm, n, "--dry-run");
    }
    const t2 = readJson<AttemptRecord>(attemptPaths(cfg, "T", 2).record);
    assert.deepEqual(
      [t2.classification?.outcome, t2.classification?.exclusionCause, t2.agentCheck?.mismatched.map((x) => x.reasons)],
      ["infrastructureExcluded", "modelMismatch", [["configured model sonnet", "recorded model claude-sonnet-5-5", "resolved model claude-sonnet-5-5"]]],
    );
    const t1 = readJson<AttemptRecord>(attemptPaths(cfg, "T", 1).record);
    assert.deepEqual([t1.agentCheck?.mismatched, t1.agentCheck?.agents, (t1.artifacts ?? []).filter((a) => a.kind === "ticket").length], [[], 4, 4]);
    const report = buildReport(cfg, loadAttempts(cfg));
    const sections = [
      "## v3 — one conversation, plan then build",
      "### Features complete",
      "### Cost and time",
      "### Agents and subagents",
      "### Traycer's ticket artifacts",
      "### Harness overhead and context growth, per session",
      "### Reasoning effort",
      "### Calls outside the attempt's transcripts",
      "### Traycer agents retired",
    ];
    assert.deepEqual(sections.filter((h) => !report.includes(`${h}\n`)), []);
    assert.match(report, /\| T-2 \| `[0-9a-f-]{12}` \| child \| .* \| \*\*off: configured model sonnet; recorded model claude-sonnet-5-5; resolved model claude-sonnet-5-5\*\* \|/);
    assert.deepEqual(artifactStatuses(path.join(attemptPaths(cfg, "T", 1).dir, "artifacts-final")).map((a) => a.status), [null, 2, 2, 2, 1]);
    // A dry ledger carries no session header, so there is no background column to fill.
    assert.match(report, /\| T-1 \| build \| \d+ \| \d+ \| \S+ \| \S+ \| no header \| — \| \d+ \|/);

    // A background call shows per turn and per attempt, and stays in own cost.
    const t1Path = attemptPaths(cfg, "T", 1).record;
    const ownBefore = /\| T-1 \| (\S+) \| (\S+) \| (\S+) \|/.exec(report)?.slice(1);
    const withBackground = readJson<AttemptRecord>(t1Path);
    const attributionB = withBackground.callAttribution?.B;
    assert.ok(attributionB !== undefined);
    attributionB.background = [
      { messageId: "msg_bg", ts: "2026-10-11T19:11:19.187Z", model: "claude-opus-5-5", usd: 0.0182, promptTokens: 70553, outputTokens: 32, sessionId: "s-coord", xApp: "cli-bg", agentId: "coord-agent-id" },
    ];
    fs.writeFileSync(t1Path, JSON.stringify(withBackground, null, 2));
    const shown = buildReport(cfg, loadAttempts(cfg));
    assert.match(shown, /\| T-1 \| build \| \d+ \| \d+ \| \S+ \| \S+ \| 1 \| \$0\.0182 \| \d+ \|/);
    assert.match(shown, /\| T-1 \| \S+ \| \S+ \| \S+ \| \S+ \| 1 \| \$0\.0182 \|/);
    assert.deepEqual(/\| T-1 \| (\S+) \| (\S+) \| (\S+) \|/.exec(shown)?.slice(1), ownBefore);
    assert.match(shown, /- `T-1` build turn, `msg_bg` at 2026-10-11T19:11:19\.187Z, claude-opus-5-5, \$0\.0182: background call in session `s-coord` \(`x-app: cli-bg`\), agent `coord-agent-`/);
  });

  await check("v3: rig run refuses in both arms, before creating anything, when the pin and Traycer's pack differ or either is unreadable", async () => {
    // A pack laid out as Traycer's, in the test's own temp dir: the stand-in as 2.1.284, and a binary that cannot say its version.
    const root = path.join(tmp, "v3-launch", "providers", "claude", "darwin-arm64");
    fs.mkdirSync(path.join(root, "2.1.284"), { recursive: true });
    fs.mkdirSync(path.join(root, "broken"), { recursive: true });
    const pin = path.join(root, "2.1.284", "stand-in-claude.mjs");
    fs.symlinkSync(path.join(rigRoot, "scripts", "stand-in-claude.mjs"), pin);
    const broken = path.join(root, "broken", "stand-in-claude.mjs");
    fs.writeFileSync(broken, "#!/bin/sh\necho 'no build here' >&2\nexit 3\n");
    fs.chmodSync(broken, 0o755);
    const pointer = path.join(root, "current.json");
    const point = (v: string | null): void => (v === null ? fs.rmSync(pointer, { force: true }) : fs.writeFileSync(pointer, JSON.stringify({ version: v })));

    const { cfg } = v3Cfg("v3-launch");
    const withPin = (binary: string): string => {
      const file = path.join(tmp, "v3-launch", `bench-${path.basename(path.dirname(binary))}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...cfg, claudeBinary: binary }));
      return file;
    };
    const attempt = (file: string, arm: "C" | "T") => {
      const res = spawnSync(rigBin, ["run", arm, "1", "--dry-run", "--config", file], { encoding: "utf8" });
      return {
        status: res.status,
        refusal: /refusing to start the attempt: (.*)/.exec(res.stderr)?.[1] ?? null,
        created: fs.existsSync(attemptPaths(cfg, arm, 1).dir),
      };
    };
    const cases = [
      {
        binary: pin,
        current: "2.1.289",
        refusal:
          "claudeBinary is 2.1.284 but Traycer now runs 2.1.289 (current.json); arm C would be on 2.1.284 and arm T on 2.1.289. " +
          "Repin claudeBinary to the 2.1.289 path",
      },
      { binary: pin, current: null, refusal: `Traycer's current pack version cannot be read from ${pointer}` },
      { binary: broken, current: "2.1.284", refusal: `the pinned binary's version cannot be read: \`${broken} --version\` exited 3: no build here` },
    ];
    for (const c of cases) {
      point(c.current);
      for (const arm of ["C", "T"] as const) {
        assert.deepEqual(attempt(withPin(c.binary), arm), { status: 1, refusal: c.refusal, created: false }, `arm ${arm}, current.json ${c.current}`);
      }
    }

    point("2.1.284");
    const same = await readPinnedBuild(pin);
    assert.deepEqual([same.pinnedVersion, same.current, pinnedBuildProblem(same)], ["2.1.284", "2.1.284", null]);

    // `rig phase-a` on its own refuses too, before the stand-in runs, and records the build it launched on once it may.
    const file = withPin(pin);
    rigV3(file, "new", "C", "2", "--dry-run");
    const c2 = attemptPaths(cfg, "C", 2);
    point("2.1.289");
    const drifted = spawnSync(rigBin, ["phase-a", "C", "2", "--dry-run", "--config", file], { encoding: "utf8" });
    assert.deepEqual(
      [drifted.status, /refusing to start the attempt: claudeBinary is 2\.1\.284 but Traycer now runs 2\.1\.289/.test(drifted.stderr), readJson<AttemptRecord>(c2.record).phases.A, walk(c2.claudeConfig).length],
      [1, true, undefined, 0],
    );
    point("2.1.284");
    rigV3(file, "phase-a", "C", "2", "--dry-run");
    const launched = readJson<AttemptRecord>(c2.record).launchBuild;
    assert.deepEqual({ ...launched, checkedAt: typeof launched?.checkedAt }, { binary: pin, pinnedVersion: "2.1.284", currentPack: "2.1.284", checkedAt: "string" });
  });

  /** A transcript whose assistant records carry these versions, null for none, then a bookkeeping record Claude Code writes without one. */
  const versioned = (sessionId: string, versions: (string | null)[]): string =>
    versions
      .map((v, i) => {
        const r = JSON.parse(cc(sessionId, `m-${sessionId}-${i}`, "claude-opus-5-5", "high")) as Record<string, unknown>;
        if (v === null) delete r["version"];
        else r["version"] = v;
        return JSON.stringify(r);
      })
      .concat(JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId }))
      .join("\n") + "\n";

  await check("one session off the pinned build excludes the attempt as buildMismatch: an arm-C session, an arm-T child, a subagent", () => {
    const { cfg } = v3Cfg("v3-build");
    const ok = "2.1.284";
    const off = "2.1.289";

    // Arm C: the session as the build turn kept it, and a subagent's transcript beside it.
    const pc = attemptPaths(cfg, "C", 1);
    const subDir = subagentArchiveDir(pc, "B");
    fs.mkdirSync(subDir, { recursive: true });
    const main = path.join(pc.transcripts, "phase-b.jsonl");
    const recordC = { attemptId: "C-1", arm: "C", n: 1, phases: { B: { sessionId: "sid-c", transcriptPath: main } }, manifestCheckAfterA: null } as unknown as AttemptRecord;
    const armC = (session: (string | null)[], sub: (string | null)[]) => {
      fs.writeFileSync(main, versioned("sid-c", session));
      fs.writeFileSync(path.join(subDir, "agent-sub1.jsonl"), versioned("sid-c", sub));
      const buildCheck = tallyVersions(attemptAgents(cfg, recordC, pc), ok, "launch");
      return { offPin: buildCheck.offPin, total: buildCheck.total, excluded: classify({ ...recordC, buildCheck }, null).exclusionCause };
    };
    assert.deepEqual(armC([ok, ok], [ok]), { offPin: [], total: { [ok]: 3 }, excluded: null });
    assert.deepEqual(armC([ok, off], [ok]), { offPin: [{ agentId: "sid-c", reasons: [`version ${off} on 1 record(s)`] }], total: { [ok]: 2, [off]: 1 }, excluded: "buildMismatch" });
    assert.deepEqual(armC([ok], [off, off]), { offPin: [{ agentId: "sub1", reasons: [`version ${off} on 2 record(s)`] }], total: { [ok]: 1, [off]: 2 }, excluded: "buildMismatch" });
    assert.deepEqual(armC([ok], [null]), { offPin: [{ agentId: "sub1", reasons: ["no version in agent-sub1.jsonl"] }], total: { [ok]: 1 }, excluded: "buildMismatch" });

    // Arm T: the coordinator's and a child's sessions as `collectSessions` copies them, and a subagent of the child's.
    const pt = attemptPaths(cfg, "T", 1);
    const roster: RosterEntry[] = [
      { agentId: "coord", parentId: "sender", depth: 0, title: "c", harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", claudeSessionIds: ["s-coord"], nativeUsd: null, settingsFrom: "stub" },
      { agentId: "kid", parentId: "coord", depth: 1, title: "k", harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", claudeSessionIds: ["s-kid"], nativeUsd: null, settingsFrom: "stub" },
    ];
    const recordT = { attemptId: "T-1", arm: "T", n: 1, phases: {}, manifestCheckAfterA: null, roster } as unknown as AttemptRecord;
    const kidSub = path.join(sessionsDir(pt), "kid", "s-kid", "subagents");
    fs.mkdirSync(kidSub, { recursive: true });
    fs.mkdirSync(path.join(sessionsDir(pt), "coord"), { recursive: true });
    const armT = (coord: (string | null)[], kid: (string | null)[], sub: (string | null)[]) => {
      fs.writeFileSync(path.join(sessionsDir(pt), "coord", "s-coord.jsonl"), versioned("s-coord", coord));
      fs.writeFileSync(path.join(sessionsDir(pt), "kid", "s-kid.jsonl"), versioned("s-kid", kid));
      fs.writeFileSync(path.join(kidSub, "agent-ksub.jsonl"), versioned("s-kid", sub));
      const buildCheck = tallyVersions(attemptAgents(cfg, recordT, pt), ok, "launch");
      return { offPin: buildCheck.offPin, excluded: classify({ ...recordT, buildCheck }, null).exclusionCause };
    };
    assert.deepEqual(armT([ok], [ok, ok], [ok]), { offPin: [], excluded: null });
    assert.deepEqual(armT([ok], [ok, off], [ok]), { offPin: [{ agentId: "kid", reasons: [`version ${off} on 1 record(s)`] }], excluded: "buildMismatch" });
    assert.deepEqual(armT([ok], [ok], [off]), { offPin: [{ agentId: "ksub", reasons: [`version ${off} on 1 record(s)`] }], excluded: "buildMismatch" });

    // Both checks off: the build is named as the cause, with the model mismatch carried in the reason.
    armT([ok], [off], [ok]);
    const both = classify(
      { ...recordT, buildCheck: tallyVersions(attemptAgents(cfg, recordT, pt), ok, "launch"), agentCheck: { mismatched: [{ agentId: "kid", reasons: ["recorded model claude-sonnet-5-5"] }] } } as unknown as AttemptRecord,
      null,
    );
    assert.deepEqual(
      [both.exclusionCause, both.reason],
      ["buildMismatch", `1 agent(s) off the pinned Claude Code ${ok}: kid (version ${off} on 1 record(s)); 1 agent(s) also off the pinned model or effort`],
    );
    // A pin that could not be read verifies nothing, so every agent with a session is off it.
    assert.deepEqual(
      tallyVersions(attemptAgents(cfg, recordT, pt), null, "measure").offPin.map((o) => o.agentId),
      ["coord", "kid", "ksub"],
    );
  });

  await check("a session an agent names but that was never archived excludes the attempt as buildMismatch, in arm T and arm C", () => {
    const { cfg } = v3Cfg("v3-unarchived");
    const ok = "2.1.284";
    const pt = attemptPaths(cfg, "T", 1);
    fs.mkdirSync(path.join(sessionsDir(pt), "coord"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(pt), "coord", "s-coord.jsonl"), versioned("s-coord", [ok]));
    const entry = (agentId: string, depth: number, claudeSessionIds: string[]): RosterEntry => ({
      agentId, parentId: depth === 0 ? "sender" : "coord", depth, title: agentId, harness: "claude", configuredModel: "opus[1m]",
      configuredEffort: "high", claudeSessionIds, nativeUsd: null, settingsFrom: "stub",
    });
    // The ghost child names a session no copy was made of, as a child in a worktree of its own might.
    const recordT = {
      attemptId: "T-1", arm: "T", n: 1, phases: {}, manifestCheckAfterA: null,
      roster: [entry("coord", 0, ["s-coord"]), entry("ghost", 1, ["s-ghost"]), entry("idle", 1, [])],
    } as unknown as AttemptRecord;
    const t = tallyVersions(attemptAgents(cfg, recordT, pt), ok, "launch");
    assert.deepEqual(
      [t.offPin, classify({ ...recordT, buildCheck: t }, null).exclusionCause],
      [[{ agentId: "ghost", reasons: ["session s-ghost not archived"] }], "buildMismatch"],
    );

    // Arm C: the session id is set but its transcript is missing; an empty id names nothing.
    const pc = attemptPaths(cfg, "C", 1);
    const missing = path.join(pc.transcripts, "phase-b.jsonl");
    const recordC = (sessionId: string) =>
      ({ attemptId: "C-1", arm: "C", n: 1, phases: { B: { sessionId, transcriptPath: missing } }, manifestCheckAfterA: null }) as unknown as AttemptRecord;
    assert.deepEqual(tallyVersions(attemptAgents(cfg, recordC("sid-c"), pc), ok, "launch").offPin, [{ agentId: "sid-c", reasons: ["session sid-c not archived"] }]);
    assert.deepEqual(tallyVersions(attemptAgents(cfg, recordC(""), pc), ok, "launch").offPin, []);
  });

  await check("the wrong-build dry run is excluded as buildMismatch, matching dry runs are not, and the v3 report shows each attempt's builds", () => {
    const { cfg, file } = v3Cfg("v3-builds");
    for (const [arm, n, scenario] of [["T", "1", "wrong-build"], ["T", "2", "success"], ["C", "1", null]] as const) {
      rigV3(file, "new", arm, n, "--dry-run");
      rigV3(file, "phase-a", arm, n, "--dry-run");
      rigV3(file, "phase-b", arm, n, "--dry-run", ...(scenario === null ? [] : ["--scenario", scenario]));
      for (const step of ["ledger", "measure", "classify"]) rigV3(file, step, arm, n, "--dry-run");
    }
    const t1 = readJson<AttemptRecord>(attemptPaths(cfg, "T", 1).record);
    const child2 = (t1.roster ?? []).find((r) => r.title === "ticket 2 builder")?.agentId;
    assert.deepEqual(
      [t1.classification?.outcome, t1.classification?.exclusionCause, t1.buildCheck?.offPin, t1.agentCheck?.mismatched],
      ["infrastructureExcluded", "buildMismatch", [{ agentId: child2, reasons: ["version 2.1.289 on 3 record(s)"] }], []],
    );
    for (const [arm, n] of [["T", 2], ["C", 1]] as const) {
      const r = readJson<AttemptRecord>(attemptPaths(cfg, arm, n).record);
      assert.deepEqual(
        {
          launch: [r.launchBuild?.pinnedVersion, r.launchBuild?.currentPack],
          pinned: [r.buildCheck?.pinnedVersion, r.buildCheck?.pinnedFrom],
          versions: Object.keys(r.buildCheck?.total ?? {}),
          unversioned: r.buildCheck?.agents.flatMap((a) => a.unversionedFiles),
          offPin: r.buildCheck?.offPin,
          excluded: r.classification?.exclusionCause,
        },
        { launch: ["2.1.284", "2.1.284"], pinned: ["2.1.284", "launch"], versions: ["2.1.284"], unversioned: [], offPin: [], excluded: null },
        `${arm}-${n}`,
      );
    }
    const c1 = readJson<AttemptRecord>(attemptPaths(cfg, "C", 1).record);
    assert.deepEqual(c1.buildCheck?.agents.map((a) => [a.kind, a.versions]), [["session", { "2.1.284": 7 }], ["subagent", { "2.1.284": 2 }], ["subagent", { "2.1.284": 2 }]]);

    const report = buildReport(cfg, loadAttempts(cfg));
    assert.equal(report.includes("### Claude Code builds\n"), true);
    assert.match(report, /\| T-1 \| 2\.1\.284 \| 2\.1\.284 \| 2\.1\.284 × \d+, 2\.1\.289 × 3 \| 0 \| \*\*off: 1 agent\(s\)\*\* \|/);
    assert.match(report, /\| C-1 \| 2\.1\.284 \| 2\.1\.284 \| 2\.1\.284 × 11 \| 0 \| on \|/);
    assert.match(report, new RegExp(`- \`T-1\` child \`${(child2 ?? "").slice(0, 12)}\`: version 2\\.1\\.289 on 3 record\\(s\\)`));
    assert.match(report, /- `T-1` — buildMismatch: 1 agent\(s\) off the pinned Claude Code 2\.1\.284/);
  });

  await check("a call no transcript carries whose session header is the attempt's own is a background call, counted as own", () => {
    const { cfg } = v3Cfg("v3-background");
    const t = probeTimeline(path.join(tmp, "v3-background"));
    const found = phaseSessionsOf(t.agents, "T");
    const b = attributeCalls(t.rows, "B", found, cfg.prices);
    assert.deepEqual(
      [b.calls, b.matched, b.foreign.length, (b.background ?? []).map((x) => [x.messageId, x.sessionId, x.xApp, x.agentId])],
      [12, 9, 0, [["bg-1", "s-coord", "cli-bg", "coord"], ["bg-2", "s-kid", "cli-bg", "kid"], ["bg-3", "s-coord", "cli-bg", "coord"]]],
    );
    const a = attributeCalls(t.rows, "A", found, cfg.prices);
    assert.deepEqual([a.foreign.length, (a.background ?? []).map((x) => x.messageId)], [0, ["bg-a"]]);
    // Own cost and the owner's cost include it; every per-session figure leaves it out.
    const measured = measureAgents(cfg, t.agents, t.rows, [...(a.background ?? []), ...(b.background ?? [])]);
    const coord = measured.agents.find((m) => m.agentId === "coord");
    const bgUsd = t.usd("bg-a", cfg.prices) + t.usd("bg-1", cfg.prices) + t.usd("bg-3", cfg.prices);
    const turnsUsd = ["m1", "m2", "m3", "m5", "m6", "m7", "m10", "m11"].reduce((sum, id) => sum + t.usd(id, cfg.prices), 0);
    assert.deepEqual([coord?.backgroundCalls, near(coord?.backgroundUsd, bgUsd), near(coord?.usd, turnsUsd + bgUsd)], [3, true, true]);
    assert.deepEqual(measured.sessionCalls.filter((sc) => sc.agentId === "coord").map((sc) => [sc.phase, sc.calls]), [["A", 2], ["B", 6]]);
    assert.deepEqual(harnessOverhead(leaveOutForeign(t.rows, b, "B"), "B").calls, 9);
  });

  await check("a call whose session header names a session outside the attempt stays foreign, with that session", () => {
    const t = probeTimeline(path.join(tmp, "v3-other-session"));
    const rows = [...t.rows, { ...t.row("B", "x-1", "2026-10-11T19:11:20.000Z", 50_000, 30), sessionId: "s-elsewhere", xApp: "cli" }];
    const b = attributeCalls(rows, "B", phaseSessionsOf(t.agents, "T"), prices);
    assert.deepEqual(
      [b.foreign.map((f) => [f.messageId, f.belongsTo, f.sessionId]), (b.background ?? []).length],
      [[["x-1", "otherSession", "s-elsewhere"]], 3],
    );
  });

  await check("a ledger without the session header is attributed exactly as before: no background list, unseen calls foreign", () => {
    const t = probeTimeline(path.join(tmp, "v3-no-header"));
    const bare = t.rows.map((r) => {
      const { sessionId: _s, xApp: _x, agentId: _a, ...rest } = r;
      return rest as LedgerRow;
    });
    const found = phaseSessionsOf(t.agents, "T");
    const b = attributeCalls(bare, "B", found, prices);
    const foreign = (id: string, ts: string) => {
      const u = t.rows.find((r) => r.messageId === id)?.usage as Exclude<LedgerRow["usage"], "unknown">;
      return {
        messageId: id, ts, model: "claude-opus-5-5", usd: priceBuckets(u, prices),
        promptTokens: u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h, outputTokens: u.output, belongsTo: "noSession", sessionId: null,
      };
    };
    assert.deepEqual(b, {
      available: true,
      note: null,
      ownSessionIds: found.ownSessionIds,
      ownSessionsFrom: "chatStore",
      sessions: found.sessions.map((x) => ({ sessionId: x.sessionId, file: x.file, own: true, messageIds: x.messageIds.size })),
      calls: 12,
      matched: 9,
      noMessageId: 0,
      foreign: [foreign("bg-1", "2026-10-11T19:11:07.978Z"), foreign("bg-2", "2026-10-11T19:11:14.747Z"), foreign("bg-3", "2026-10-11T19:11:19.187Z")],
    });
  });

  await check("background calls take no part in the pin check, but count in the owner's cost", () => {
    const { cfg } = v3Cfg("v3-background-pin");
    const t = probeTimeline(path.join(tmp, "v3-background-pin"));
    const found = phaseSessionsOf(t.agents, "T");
    // A side request on another model must not put the agent off the pin.
    const rows = t.rows.map((r) => (r.messageId === "bg-3" ? { ...r, model: "claude-haiku-5-5" } : r));
    const background = (["A", "B"] as Phase[]).flatMap((ph) => attributeCalls(rows, ph, found, prices).background ?? []);
    assert.equal(background.find((x) => x.messageId === "bg-3")?.model, "claude-haiku-5-5");
    const m = measureAgents(cfg, t.agents, rows, background);
    const coord = m.agents.find((a) => a.agentId === "coord");
    assert.deepEqual([m.check.mismatched, coord?.ledgerModels, coord?.backgroundCalls], [[], ["claude-opus-5-5"], 3]);
  });

  await check("arm C's token reconcile leaves subagent calls out of the ledger side, since claude -p counts the main thread only", () => {
    const dir = path.join(tmp, "v3-reconcile-c");
    fs.mkdirSync(path.join(dir, "subagents"), { recursive: true });
    const main = path.join(dir, "session.jsonl");
    const sub = path.join(dir, "subagents", "agent-a1.jsonl");
    fs.writeFileSync(main, ["c-a", "c-b1", "c-b2"].map((id) => cc("s-c", id, "claude-opus-5-5", "high")).join("\n") + "\n");
    fs.writeFileSync(sub, cc("s-c", "c-sub", "claude-opus-5-5", "high", { isSidechain: true }) + "\n");
    const buckets = (input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number) =>
      ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h, cacheWriteTierAssumed: false, raw: null });
    // C-0's own buckets.
    const rows: LedgerRow[] = [
      { ...ledgerRow("A", "c-a", "2026-10-11T19:09:38.331Z"), usage: buckets(2, 4, 0, 0, 18584) },
      { ...ledgerRow("B", "c-b1", "2026-10-11T19:09:44.060Z"), usage: buckets(2, 437, 15093, 0, 3684) },
      { ...ledgerRow("B", "c-sub", "2026-10-11T19:09:45.292Z"), usage: buckets(2, 7, 0, 13038, 0) },
      { ...ledgerRow("B", "c-b2", "2026-10-11T19:09:47.030Z"), usage: buckets(2, 76, 18777, 0, 703) },
    ];
    const cost = summarise("C-0", rows, prices);
    const native = (input: number, output: number, cacheRead: number, cacheWrite: number, usd: number | null) =>
      ({ input, output, cacheRead, cacheWrite, usd, source: "claude -p --output-format json" });
    const record = {
      attemptId: "C-0", arm: "C", n: 0,
      phases: { A: { phase: "A", nativeUsage: native(2, 4, 0, 18584, cost.perPhase.A?.usd ?? null) }, B: { phase: "B", nativeUsage: native(4, 513, 33870, 4387, cost.perPhase.B?.usd ?? null) } },
    } as unknown as AttemptRecord;
    const agents = [
      { agentId: "s-c", kind: "session" as const, parentId: null, depth: 0, title: null, harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", sessionIds: ["s-c"], files: [{ sessionId: "s-c", file: main }] },
      { agentId: "a1", kind: "subagent" as const, parentId: "s-c", depth: 1, title: null, harness: "claude", configuredModel: "opus[1m]", configuredEffort: null, sessionIds: [], files: [{ sessionId: "a1", file: sub }] },
    ];
    const whole = reconcile(record, cost, 0.02);
    assert.deepEqual([whole.phases[1]?.tokenDelta, whole.phases[1]?.flagged], [-13047, true]);
    const r = reconcile(record, cost, 0.02, reconcileAdjustmentsV3("C", agents, rows, prices));
    assert.deepEqual(
      r.phases.map((ph) => [ph.phase, ph.ledgerTokens, ph.comparedLedgerTokens, ph.tokenDelta, ph.usdRatio, ph.flagged]),
      [["A", 18590, undefined, 0, 0, false], ["B", 51821, 38774, 0, 0, false]],
    );
    assert.equal(r.flagged, false);
    assert.match(r.phases[1]?.note ?? "", /tokens compared without 1 subagent call\(s\), 13047 tokens: claude -p reports the main thread's tokens only; USD compared whole/);
  });

  await check("arm T's USD reconcile drops background calls no later turn recorded, and carries the plan turn's into the build", () => {
    const t = probeTimeline(path.join(tmp, "v3-reconcile-t"));
    const cost = summarise("T-0", t.rows, prices);
    const ledgerA = cost.perPhase.A?.usd as number;
    const ledgerB = cost.perPhase.B?.usd as number;
    // What the host records: each agent's cost as of its last turn; the coordinator's at the plan turn too.
    const nativeA = ledgerA - t.usd("bg-a");
    const nativeB = ledgerB - t.usd("bg-2") - t.usd("bg-3") + t.usd("bg-a");
    const native = (usd: number) => ({ input: null, output: null, cacheRead: null, cacheWrite: null, usd, source: "traycer chat store" });
    const record = {
      attemptId: "T-0", arm: "T", n: 0,
      phases: { A: { phase: "A", nativeUsage: native(nativeA) }, B: { phase: "B", nativeUsage: native(nativeB) } },
    } as unknown as AttemptRecord;
    assert.deepEqual(reconcile(record, cost, 0.02).phases.map((ph) => ph.flagged), [true, true]);
    const adjust = reconcileAdjustmentsV3("T", t.agents, t.rows, prices);
    assert.deepEqual(
      (adjust.background ?? []).map((b) => [b.phase, b.messageId, b.recordedIn]),
      [["A", "bg-a", "B"], ["B", "bg-1", "B"], ["B", "bg-2", null], ["B", "bg-3", null]],
    );
    const r = reconcile(record, cost, 0.02, adjust);
    assert.deepEqual(r.phases.map((ph) => [ph.phase, ph.flagged, (ph.usdRatio ?? 1) < 1e-9]), [["A", false, true], ["B", false, true]]);
    assert.match(r.phases[0]?.note ?? "", /native has not recorded 1 background call\(s\) made after the agent's last turn, subtracted: bg-a at 2026-10-11T19:10:51\.231Z/);
    assert.match(r.phases[1]?.note ?? "", /subtracted: bg-2 at .*; bg-3 at .*; native recorded 1 background call\(s\) from the plan turn with this turn, added: bg-a/);
    // Without the header nothing is identified, and the reconcile is today's.
    const bare = t.rows.map((row) => ({ ...row, sessionId: undefined }));
    const today = reconcile(record, cost, 0.02, reconcileAdjustmentsV3("T", t.agents, bare, prices));
    assert.deepEqual(today, reconcile(record, cost, 0.02));
  });

  await check("the roster takes a Claude session the squashed op log lost from the chat's own message rows, claude anchors only", async () => {
    const dir = path.join(tmp, "v3-anchors");
    fs.mkdirSync(dir, { recursive: true });
    const db = path.join(dir, "chat-coord.db");
    const q = (v: unknown): string => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    const anchor = (sessionId: string, harnessId?: string) => ({ sessionAnchor: { ...(harnessId !== undefined ? { harnessId } : {}), sessionId, hostId: "h" } });
    const message = (chatId: string, id: string, seq: number, body: unknown, fold: unknown, harnesses: string[] | null) =>
      `INSERT INTO chat_message VALUES('${chatId}', '${id}', ${seq}, ${seq}, NULL, 1, NULL, ${q(fold)}, ${harnesses === null ? "NULL" : q(harnesses)}, ${q({ messageId: id, role: "user", ...(body as object) })});`;
    const sql = [
      "CREATE TABLE chat_op_log(chat_id TEXT, seq INTEGER, op_id TEXT, op_json TEXT, recorded_at INTEGER);",
      "CREATE TABLE chat_message(chat_id TEXT NOT NULL, message_id TEXT NOT NULL, insert_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, removed_seq INTEGER, byte_length INTEGER NOT NULL, turn_key TEXT, fold_facts TEXT NOT NULL, harness_ids TEXT, body TEXT NOT NULL);",
      // The op log kept one session; the squashed one survives only as text inside a tool input.
      `INSERT INTO chat_op_log VALUES('coord', 900, 'o1', ${q({ chatId: "coord", type: "chat.metadata", data: { activeSessionChain: { harnessId: "claude", sessionId: "s-op" } } })}, 1);`,
      `INSERT INTO chat_op_log VALUES('coord', 901, 'o2', ${q({ chatId: "coord", type: "message.upsert", messageId: "u9", message: { messageId: "u9", role: "assistant", blocks: [{ type: "tool_call", toolName: "Bash", inputDetail: { kind: "command", command: "ls ~/.claude/projects/x/s-squashed.jsonl" } }] } })}, 2);`,
      message("coord", "u1", 1, anchor("s-squashed", "claude"), anchor("s-squashed", "claude"), ["claude"]),
      // Received from a codex sender: the row says codex, the anchor is the coordinator's claude session.
      message("coord", "u2", 2, anchor("s-squashed", "claude"), anchor("s-squashed", "claude"), ["codex"]),
      message("coord", "u3", 3, {}, anchor("s-fold-only", "claude"), ["claude"]),
      message("coord", "u4", 4, anchor("s-codex", "codex"), anchor("s-codex", "codex"), ["codex"]),
      message("coord", "u5", 5, anchor("s-unlabelled"), {}, ["claude"]),
      message("coord", "u6", 6, anchor("s-unlabelled-codex"), {}, ["codex"]),
      message("sender", "x1", 1, anchor("s-sender", "claude"), anchor("s-sender", "claude"), ["claude"]),
    ];
    const made = spawnSync("sqlite3", [db], { input: sql.join("\n") + "\n" });
    assert.equal(made.status, 0, made.stderr.toString());
    const before = fs.readdirSync(dir).sort();
    const chat = await readChatAt(db, "coord", fs.mkdtempSync(path.join(tmp, "v3-anchors-scratch-")));
    assert.deepEqual(
      [chat.claudeSessionIds, rosterSessionIds(chat)],
      [["s-op"], ["s-op", "s-squashed", "s-fold-only", "s-unlabelled"]],
    );
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "nothing is written beside the stored copy");
  });

  /** One attempt's project folder: the coordinator's session, a session no agent names with a subagent, and a bookkeeping-only file. */
  const sweptAttempt = (name: string, lostVersion: string) => {
    const { cfg } = v3Cfg(name);
    const p = attemptPaths(cfg, "T", 1);
    const configDir = path.join(tmp, name, "claude");
    const folder = projectFolder(configDir, p.work);
    fs.mkdirSync(path.join(folder, "s-lost", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(folder, "s-coord.jsonl"), cc("s-coord", "m-coord", "claude-opus-5-5", "high", { version: "2.1.284" }) + "\n");
    fs.writeFileSync(path.join(folder, "s-lost.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "s-lost", version: lostVersion, message: { role: "user", content: "go" } }),
      cc("s-lost", "m-lost", "claude-opus-5-5", "high", { version: lostVersion }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(folder, "s-lost", "subagents", "agent-lsub.jsonl"), cc("s-lost", "m-lsub", "claude-opus-5-5", "high", { version: lostVersion, isSidechain: true }) + "\n");
    fs.writeFileSync(path.join(folder, "s-book.jsonl"), [
      { type: "last-prompt", sessionId: "s-book", lastPrompt: "go" },
      { type: "custom-title", sessionId: "s-book", customTitle: "bench" },
      { type: "cost-state", sessionId: "s-book" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const roster: RosterEntry[] = [
      { agentId: "coord", parentId: "sender", depth: 0, title: "c", harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", claudeSessionIds: ["s-coord"], nativeUsd: null, settingsFrom: "stub" },
    ];
    collectSessions(roster, configDir, p.work, sessionsDir(p));
    const unmappedSessions = collectUnmapped(roster, configDir, p.work, unmappedDir(p));
    const record = { attemptId: "T-1", arm: "T", n: 1, phases: {}, manifestCheckAfterA: null, roster, unmappedSessions } as unknown as AttemptRecord;
    return { cfg, p, record, unmappedSessions };
  };

  await check("a session in the attempt's project folder no agent names is archived, counted as own, and checked like any agent", () => {
    const { cfg, p, record, unmappedSessions } = sweptAttempt("v3-unmapped", "2.1.284");
    assert.deepEqual(
      unmappedSessions.map((u) => [u.sessionId, path.relative(sessionsDir(p), u.file), u.userRecords, u.assistantRecords, u.bookkeeping, u.subagentFiles]),
      [["s-book", "unmapped/s-book.jsonl", 0, 0, true, 0], ["s-lost", "unmapped/s-lost.jsonl", 1, 1, false, 1]],
    );
    const agents = attemptAgents(cfg, record, p);
    assert.deepEqual(agents.map((a) => [a.agentId, a.kind, a.parentId]), [["coord", "coordinator", "sender"], ["s-lost", "unmapped", null], ["lsub", "subagent", "s-lost"]]);
    const rows = [v3Row("B", "m-coord"), v3Row("B", "m-lost"), v3Row("B", "m-lsub"), { ...v3Row("B", "m-bg"), sessionId: "s-lost", xApp: "cli-bg" }];
    const b = attributeCalls(rows, "B", phaseSessionsOf(agents, "T"), prices);
    assert.deepEqual(
      [b.matched, b.foreign.map((f) => f.messageId), (b.background ?? []).map((x) => [x.messageId, x.agentId])],
      [3, [], [["m-bg", "s-lost"]]],
    );
    const off = sweptAttempt("v3-unmapped-off", "2.1.289");
    const build = tallyVersions(attemptAgents(off.cfg, off.record, off.p), "2.1.284", "launch");
    assert.deepEqual(
      [build.offPin, classify({ ...off.record, buildCheck: build }, null).exclusionCause],
      [[{ agentId: "s-lost", reasons: ["version 2.1.289 on 2 record(s)"] }, { agentId: "lsub", reasons: ["version 2.1.289 on 1 record(s)"] }], "buildMismatch"],
    );
    const pin = measureAgents(cfg, agents, rows.map((r) => (r.messageId === "m-lsub" ? { ...r, model: "claude-haiku-5-5" } : r)));
    assert.deepEqual(pin.check.mismatched, [{ agentId: "lsub", reasons: ["resolved model claude-haiku-5-5"] }]);
    assert.deepEqual(
      auditTranscriptsV3(cfg, record, p, new Map()).map((t) => t.source),
      ["coordinator coord, session s-coord", "unmapped session s-lost", "subagent lsub of unmapped session s-lost"],
    );
  });

  await check("a file with no user or assistant record is listed and ignored, never tripping the build check's no-version rule", () => {
    const { cfg, p, record } = sweptAttempt("v3-bookkeeping", "2.1.284");
    // The coordinator also names a bookkeeping-only session, as a resumed session can leave behind.
    const coordDir = path.join(sessionsDir(p), "coord");
    fs.copyFileSync(path.join(unmappedDir(p), "s-book.jsonl"), path.join(coordDir, "s-book.jsonl"));
    const roster = (record.roster ?? []).map((a) => ({ ...a, claudeSessionIds: [...a.claudeSessionIds, "s-book"] }));
    const build = tallyVersions(attemptAgents(cfg, { ...record, roster }, p), "2.1.284", "launch");
    assert.deepEqual(
      [build.offPin, build.agents.map((a) => [a.agentId, a.unversionedFiles.length, (a.bookkeepingFiles ?? []).map((f) => path.basename(f))])],
      [[], [["coord", 0, ["s-book.jsonl"]], ["s-lost", 0, []], ["lsub", 0, []]]],
    );
    // A file that holds a conversation and no version is still off the pin.
    fs.writeFileSync(path.join(coordDir, "s-book.jsonl"), JSON.stringify({ type: "user", sessionId: "s-book", message: { role: "user", content: "go" } }) + "\n");
    assert.deepEqual(tallyVersions(attemptAgents(cfg, { ...record, roster }, p), "2.1.284", "launch").offPin, [{ agentId: "coord", reasons: ["no version in s-book.jsonl"] }]);
  });

  await check("arm C's reconcile flags on USD alone: tokens off with matching USD stay in the record, unflagged", () => {
    const dir = path.join(tmp, "v3-reconcile-usd");
    fs.mkdirSync(path.join(dir, "subagents"), { recursive: true });
    const main = path.join(dir, "session.jsonl");
    const sub = path.join(dir, "subagents", "agent-a1.jsonl");
    fs.writeFileSync(main, ["u-b1", "u-b2"].map((id) => cc("s-c", id, "claude-opus-5-5", "high")).join("\n") + "\n");
    fs.writeFileSync(sub, cc("s-c", "u-sub", "claude-opus-5-5", "high", { isSidechain: true }) + "\n");
    const buckets = (input: number, output: number, cacheRead: number, cacheWrite5m: number) =>
      ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h: 0, cacheWriteTierAssumed: false, raw: null });
    const rows: LedgerRow[] = [
      { ...ledgerRow("B", "u-b1", "2026-10-11T19:09:44.060Z"), usage: buckets(2, 437, 150_000, 3684) },
      { ...ledgerRow("B", "u-sub", "2026-10-11T19:09:45.292Z"), usage: buckets(2, 7, 0, 13038) },
      { ...ledgerRow("B", "u-b2", "2026-10-11T19:09:47.030Z"), usage: buckets(2, 76, 180_000, 703) },
    ];
    const cost = summarise("C-0", rows, prices);
    // C-0's shape: a third of the main thread's tokens reported, the USD to the cent.
    const record = {
      attemptId: "C-0", arm: "C", n: 0,
      phases: { B: { phase: "B", nativeUsage: { input: 4, output: 513, cacheRead: 110_000, cacheWrite: 4387, usd: cost.perPhase.B?.usd ?? null, source: "claude -p --output-format json" } } },
    } as unknown as AttemptRecord;
    const agents = [
      { agentId: "s-c", kind: "session" as const, parentId: null, depth: 0, title: null, harness: "claude", configuredModel: "opus[1m]", configuredEffort: "high", sessionIds: ["s-c"], files: [{ sessionId: "s-c", file: main }] },
      { agentId: "a1", kind: "subagent" as const, parentId: "s-c", depth: 1, title: null, harness: "claude", configuredModel: "opus[1m]", configuredEffort: null, sessionIds: [], files: [{ sessionId: "a1", file: sub }] },
    ];
    const r = reconcile(record, cost, 0.02, reconcileAdjustmentsV3("C", agents, rows, prices));
    const b = r.phases[0];
    assert.deepEqual(
      [b?.nativeTokens, b?.comparedLedgerTokens, (b?.tokenRatio ?? 0) > 0.5, b?.usdRatio, b?.flagged, r.flagged],
      [114904, 334904, true, 0, false, false],
    );
    assert.match(b?.note ?? "", /tokens compared without 1 subagent call\(s\), 13047 tokens: .*; USD compared whole; tokens for information only, flagged on USD alone: /);
    // USD off still flags, and so does a native counter with no USD to compare.
    const usdOff = { ...record, phases: { B: { ...record.phases.B, nativeUsage: { ...record.phases.B?.nativeUsage, usd: (cost.perPhase.B?.usd ?? 0) * 1.05 } } } } as unknown as AttemptRecord;
    assert.equal(reconcile(usdOff, cost, 0.02, reconcileAdjustmentsV3("C", agents, rows, prices)).flagged, true);
    const noUsd = { ...record, phases: { B: { ...record.phases.B, nativeUsage: { ...record.phases.B?.nativeUsage, usd: null } } } } as unknown as AttemptRecord;
    assert.equal(reconcile(noUsd, cost, 0.02, reconcileAdjustmentsV3("C", agents, rows, prices)).flagged, true);
  });

  await check("rig recollect re-reads a stored v3 attempt's project folder: an unmapped session is measured as own, a bookkeeping file only listed", () => {
    const { cfg, file } = v3Cfg("v3-recollect");
    rigV3(file, "new", "T", "1", "--dry-run");
    rigV3(file, "phase-a", "T", "1", "--dry-run");
    rigV3(file, "phase-b", "T", "1", "--dry-run");
    const p = attemptPaths(cfg, "T", 1);
    const folder = projectFolder(path.join(p.dir, "claude-config-stub"), p.work);
    fs.writeFileSync(path.join(folder, "s-late.jsonl"), cc("s-late", "m-late", "claude-opus-5-5", "high") + "\n");
    fs.writeFileSync(path.join(folder, "s-book.jsonl"), JSON.stringify({ type: "custom-title", sessionId: "s-book", customTitle: "x" }) + "\n");
    const template = readLedger(p.ledger).find((r) => r.metered && r.phase === "B" && r.messageId !== null) as LedgerRow;
    fs.appendFileSync(p.ledger, JSON.stringify({ ...template, messageId: "m-late", ts: "2026-10-11T23:59:00.000Z" }) + "\n");
    assert.throws(() => rigV3(file, "recollect", "C", "1", "--dry-run"));
    for (const step of ["ledger", "measure"]) rigV3(file, step, "T", "1", "--dry-run");
    const before = readJson<AttemptRecord>(p.record).callAttribution?.B?.foreign.map((f) => f.messageId);
    rigV3(file, "recollect", "T", "1", "--dry-run");
    for (const step of ["ledger", "measure", "classify"]) rigV3(file, step, "T", "1", "--dry-run");
    const r = readJson<AttemptRecord>(p.record);
    assert.deepEqual(
      [
        (r.unmappedSessions ?? []).map((u) => [u.sessionId, u.bookkeeping]),
        r.agents?.filter((a) => a.kind === "unmapped").map((a) => [a.agentId, a.calls]),
        [before?.includes("m-late"), r.callAttribution?.B?.foreign.map((f) => f.messageId)],
        r.buildCheck?.agents.filter((a) => a.kind === "unmapped").map((a) => a.agentId),
        r.buildCheck?.offPin,
      ],
      [[["s-book", true], ["s-late", false]], [["s-late", { B: 1 }]], [true, before?.filter((id) => id !== "m-late")], ["s-late"], []],
    );
    const report = buildReport(cfg, loadAttempts(cfg));
    assert.match(report, /### Sessions no agent names\n[\s\S]*- `T-1` `s-book`: bookkeeping only, no call made, ignored\n- `T-1` `s-late`: unmapped session of the attempt, 1 assistant record\(s\), 0 subagent transcript\(s\)\n/);
  });
}

function near(a: number | null | undefined, b: number): boolean {
  return a !== null && a !== undefined && Math.abs(a - b) < 1e-9;
}

/**
 * T-0's plan and build turns as the ledger and sessions recorded them, with the
 * session header the proxy now reads: the coordinator's session and its subagent,
 * one child, and four background calls each 2 to 3 seconds after a turn ended.
 */
function probeTimeline(dir: string): {
  agents: AgentFiles[];
  rows: LedgerRow[];
  row: (phase: string, id: string, ts: string, prompt: number, output: number) => LedgerRow;
  usd: (id: string, table?: PriceTable) => number;
} {
  const row = (phase: string, id: string, ts: string, prompt: number, output: number): LedgerRow => ({
    ...ledgerRow(phase, id, ts),
    usage: { input: 6, output, cacheRead: prompt - 6, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteTierAssumed: false, raw: null },
    durationMs: 2000,
  });
  const at = (s: string): string => `2026-10-11T19:${s}Z`;
  const own = (session: string, agent: string | null) => ({ sessionId: session, xApp: "cli", agentId: agent });
  const bg = (session: string) => ({ sessionId: session, xApp: "cli-bg", agentId: null });
  const rows: LedgerRow[] = [
    { ...row("A", "m1", at("10:47.746"), 60_000, 164), ...own("s-coord", null) },
    { ...row("A", "m2", at("10:48.592"), 60_500, 4), ...own("s-coord", null) },
    { ...row("A", "bg-a", at("10:51.231"), 68_062, 31), ...bg("s-coord") },
    { ...row("B", "m3", at("10:59.643"), 61_000, 289), ...own("s-coord", null) },
    { ...row("B", "m4", at("11:00.987"), 13_040, 7), ...own("s-coord", "sub1") },
    { ...row("B", "m5", at("11:02.734"), 62_000, 146), ...own("s-coord", null) },
    { ...row("B", "m6", at("11:04.507"), 62_500, 156), ...own("s-coord", null) },
    { ...row("B", "m7", at("11:05.427"), 63_000, 15), ...own("s-coord", null) },
    { ...row("B", "bg-1", at("11:07.978"), 69_833, 55), ...bg("s-coord") },
    { ...row("B", "m8", at("11:10.052"), 40_000, 163), ...own("s-kid", null) },
    { ...row("B", "m9", at("11:12.267"), 40_500, 59), ...own("s-kid", null) },
    { ...row("B", "m10", at("11:14.270"), 64_000, 358), ...own("s-coord", null) },
    { ...row("B", "bg-2", at("11:14.747"), 68_100, 31), ...bg("s-kid") },
    { ...row("B", "m11", at("11:16.713"), 64_500, 195), ...own("s-coord", null) },
    { ...row("B", "bg-3", at("11:19.187"), 70_553, 32), ...bg("s-coord") },
  ];
  fs.mkdirSync(path.join(dir, "subagents"), { recursive: true });
  const write = (file: string, session: string, ids: string[]): string => {
    fs.writeFileSync(file, ids.map((id) => cc(session, id, "claude-opus-5-5", "high")).join("\n") + "\n");
    return file;
  };
  const coordFile = write(path.join(dir, "s-coord.jsonl"), "s-coord", ["m1", "m2", "m3", "m5", "m6", "m7", "m10", "m11"]);
  const subFile = write(path.join(dir, "subagents", "agent-sub1.jsonl"), "s-coord", ["m4"]);
  const kidFile = write(path.join(dir, "s-kid.jsonl"), "s-kid", ["m8", "m9"]);
  const base = { harness: "claude", configuredModel: "opus[1m]", title: null };
  const agents: AgentFiles[] = [
    { ...base, agentId: "coord", kind: "coordinator", parentId: "sender", depth: 0, configuredEffort: "high", sessionIds: ["s-coord"], files: [{ sessionId: "s-coord", file: coordFile }] },
    { ...base, agentId: "sub1", kind: "subagent", parentId: "coord", depth: 1, configuredEffort: null, sessionIds: [], files: [{ sessionId: "sub1", file: subFile }] },
    { ...base, agentId: "kid", kind: "child", parentId: "coord", depth: 1, configuredEffort: "high", sessionIds: ["s-kid"], files: [{ sessionId: "s-kid", file: kidFile }] },
  ];
  const usd = (id: string, table: PriceTable = prices): number =>
    priceBuckets(rows.find((r) => r.messageId === id)?.usage as Exclude<LedgerRow["usage"], "unknown">, table) as number;
  return { agents, rows, row, usd };
}

await proxyTests();
await ledgerTests();
await statsTests();
await questionTests();
await auditTests();
await traycerTests();
await seedTests();
await armTests();
await v3Tests();

console.log(failures === 0 ? "\nall selftests passed" : `\n${failures} selftest(s) failed`);
process.exit(failures === 0 ? 0 : 1);
