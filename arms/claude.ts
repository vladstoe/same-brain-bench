import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ArmContext } from "./types.ts";
import { baseEnv, subscriptionCredential } from "./types.ts";
import type { NativeUsage, PhaseRecord, ScriptedReply } from "../src/types.ts";
import { transcriptPath } from "../src/paths.ts";
import { detectQuestion } from "../src/prompts.ts";
import { infrastructureSignal } from "../src/classify.ts";
import { nowIso, run, walk } from "../src/util.ts";
import { subagentArchiveDir } from "../src/sessions.ts";

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  model?: string;
  [k: string]: unknown;
}

export function env(ctx: ArmContext): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    // The environment arm T's harness gets through the provider override, so both
    // arms run Claude Code the same way. First, so the rig's own keys below win.
    ...(ctx.cfg.harnessEnv ?? {}),
    ...baseEnv(ctx),
    HOME: process.env["HOME"] ?? "",
    CLAUDE_CONFIG_DIR: ctx.paths.claudeConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  // The OAuth credential is keyed to the config directory, so an isolated one
  // starts signed out. Passing the token keeps the directory free of secrets.
  const token = subscriptionCredential(ctx.cfg.auth.claudeOauthTokenEnvVar);
  if (ctx.cfg.auth.mode === "subscription" && token !== undefined) {
    out[ctx.cfg.auth.claudeOauthTokenEnvVar] = token;
  }
  return out;
}

function binary(ctx: ArmContext): string {
  return ctx.cfg.claudeBinary ?? "claude";
}

export function baseArgs(ctx: Pick<ArmContext, "cfg">): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--model",
    ctx.cfg.model.armModelRef["C"] ?? ctx.cfg.model.id,
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    // On every invocation, a resumed one included: the level is per session launch.
    ...(ctx.cfg.effort !== undefined ? ["--effort", ctx.cfg.effort] : []),
  ];
}

function parseResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as ClaudeResult;
  } catch {
    /* fall through to a last-JSON-line scan */
  }
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("{")) {
      try {
        return JSON.parse(t) as ClaudeResult;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * The two counters on a result object have different scopes, and mixing them up
 * understates a phase that used a scripted reply:
 *   `usage`          is that invocation only
 *   `total_cost_usd` is cumulative for the resumed session
 * So usage is summed across invocations while the cost is taken from the last one.
 * Summing the cost instead would double count it, which is the same trap the plan
 * names for Traycer's cumulative adapter.
 */
export function nativeUsage(results: (ClaudeResult | null)[]): NativeUsage | null {
  const present = results.filter((r): r is ClaudeResult => r !== null && r.usage != null);
  if (present.length === 0) return null;

  const sum = (key: string): number | null => {
    let total: number | null = null;
    for (const r of present) {
      const v = (r.usage as Record<string, unknown>)[key];
      if (typeof v === "number") total = (total ?? 0) + v;
    }
    return total;
  };

  const withCost = results.filter(
    (r): r is ClaudeResult => r !== null && typeof r.total_cost_usd === "number",
  );
  const lastCost = withCost[withCost.length - 1]?.total_cost_usd;

  return {
    input: sum("input_tokens"),
    output: sum("output_tokens"),
    cacheRead: sum("cache_read_input_tokens"),
    cacheWrite: sum("cache_creation_input_tokens"),
    usd: typeof lastCost === "number" ? lastCost : null,
    source:
      present.length > 1
        ? `claude -p --output-format json (${present.length} invocations; usage summed, cost from the last)`
        : "claude -p --output-format json",
  };
}

function resolvedModel(result: ClaudeResult | null): string | null {
  if (result === null) return null;
  if (typeof result.model === "string") return result.model;
  const usage = result.modelUsage;
  if (usage !== undefined && usage !== null) {
    const keys = Object.keys(usage);
    if (keys.length > 0) return keys.join(",");
  }
  return null;
}

function archiveTranscript(configDir: string, sessionId: string | null, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (sessionId === null) {
    fs.writeFileSync(dest, "");
    return;
  }
  const match = walk(configDir).find((f) => path.basename(f) === `${sessionId}.jsonl`);
  fs.writeFileSync(dest, match !== undefined ? fs.readFileSync(match) : "");
}

/**
 * Everything under `<session>/subagents/`, nested folders and each subagent's
 * `.meta.json` included, at the same relative paths. Claude Code 2.1.284 can file a
 * subagent's transcript one folder deeper than `subagents/`.
 */
export function archiveSubagentTree(configDir: string, sessionId: string, destDir: string): void {
  const roots = walk(configDir, { includeDirs: true }).filter(
    (d) => path.basename(d) === "subagents" && path.basename(path.dirname(d)) === sessionId && fs.statSync(d).isDirectory(),
  );
  for (const root of roots) {
    for (const f of walk(root)) {
      if (!f.endsWith(".jsonl") && !f.endsWith(".meta.json")) continue;
      const dest = path.join(destDir, path.relative(root, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
  }
}

export async function runClaude(ctx: ArmContext): Promise<PhaseRecord> {
  const launchedAt = Date.now();
  const deadline = launchedAt + ctx.cfg.phaseTimeoutMs;
  const sessionId = ctx.resumeSessionId ?? randomUUID();
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const replies: ScriptedReply[] = [];
  const commands: string[][] = [];

  let timedOut = false;
  let exitCode: number | null = null;
  let last: ClaudeResult | null = null;
  const allResults: ClaudeResult[] = [];
  let unanswered = false;
  let message = ctx.prompt;
  let resume = ctx.resumeSessionId !== undefined;

  for (let turn = 0; turn <= ctx.cfg.maxScriptedReplies; turn++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const args = [
      ...baseArgs(ctx),
      ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
      message,
    ];
    commands.push([binary(ctx), ...args]);
    const res = await run(binary(ctx), args, {
      cwd: ctx.paths.work,
      env: env(ctx),
      timeoutMs: remaining,
    });
    stdoutParts.push(res.stdout);
    stderrParts.push(res.stderr);
    exitCode = res.code;
    timedOut = res.timedOut;
    if (timedOut) break;

    const parsed = parseResult(res.stdout);
    if (parsed !== null) allResults.push(parsed);
    last = parsed ?? last;
    const finalText = typeof last?.result === "string" ? last.result : "";
    const detection = detectQuestion(finalText);
    if (!detection.isQuestion) break;

    if (turn === ctx.cfg.maxScriptedReplies) {
      unanswered = true;
      break;
    }
    const replyText = ctx.policy[detection.kind];
    replies.push({
      kind: detection.kind,
      sentAt: nowIso(),
      triggeringText: finalText.trimEnd().slice(-800),
      replyText,
    });
    message = replyText;
    resume = true;
  }

  const settledAt = Date.now();
  const stdout = stdoutParts.join("\n");
  const stderr = stderrParts.join("\n");
  const combined = `${stdout}\n${stderr}`;

  const transcript = transcriptPath(ctx.paths, ctx.phase, "jsonl");
  archiveTranscript(ctx.paths.claudeConfig, sessionId, transcript);
  archiveSubagentTree(ctx.paths.claudeConfig, sessionId, subagentArchiveDir(ctx.paths, ctx.phase));
  const stderrPath = transcriptPath(ctx.paths, ctx.phase, "stderr.txt");
  fs.writeFileSync(stderrPath, stderr);
  fs.writeFileSync(transcriptPath(ctx.paths, ctx.phase, "result.json"), stdout);

  return {
    phase: ctx.phase,
    arm: "C",
    dryRun: ctx.dryRun,
    launchedAt: new Date(launchedAt).toISOString(),
    settledAt: new Date(settledAt).toISOString(),
    wallClockMs: settledAt - launchedAt,
    exitCode,
    timedOut,
    sessionId,
    resolvedModelId: resolvedModel(last),
    turns: typeof last?.num_turns === "number" ? last.num_turns : null,
    nativeUsage: nativeUsage(allResults),
    nativeParseNote: last === null ? "no JSON result object found on stdout" : null,
    scriptedReplies: replies,
    unansweredQuestion: unanswered,
    harnessCommand: commands[0] ?? [],
    transcriptPath: transcript,
    stderrPath,
    infrastructureSignal: infrastructureSignal(combined, (offset) => {
      const after = combined.slice(offset);
      return /"type"\s*:\s*"result"/.test(after) && !/"is_error"\s*:\s*true/.test(after);
    }),
  };
}
