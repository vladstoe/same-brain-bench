import { randomUUID } from "node:crypto";
import type { BenchConfig } from "./types.ts";
import { run } from "./util.ts";

export interface TraycerAgent {
  id: string;
  parentId: string | null;
  active: boolean;
  harnessId: string;
  surface: string;
  title: string;
  isSelf: boolean;
}

export interface InboxMessage {
  fromAgentId: string | null;
  responseId: string | null;
  text: string;
  createdAt: string | null;
  cursor: string | null;
}

export interface CreateOptions {
  epicId: string;
  senderAgentId: string;
  harness: string;
  model: string;
  cwd: string;
  name?: string;
  /** Omitted, the host fills it from the sender or a default, which is how arm T came to differ from arm C. */
  reasoningEffort?: string;
}

export interface SendOptions {
  epicId: string;
  senderAgentId: string;
  to: string;
  message: string;
  expectReply?: boolean;
  responseId?: string;
}

export interface TraycerCli {
  create(opts: CreateOptions): Promise<string>;
  send(opts: SendOptions): Promise<{ responseId: string | null }>;
  inbox(
    epicId: string,
    agentId: string,
    after?: string | null,
  ): Promise<{ messages: InboxMessage[]; nextCursor: string | null }>;
  list(epicId: string, agentId: string): Promise<TraycerAgent[]>;
  transcriptPath(epicId: string, agentId: string): Promise<string | null>;
  stop(epicId: string, agentId: string, childId: string, cascade: boolean): Promise<boolean>;
  /** `agent stop` or `agent archive` on `targetId`, run as `actingAs`, with the CLI's own answer. */
  manage(
    action: "stop" | "archive",
    epicId: string,
    actingAs: string,
    targetId: string,
    cascade?: boolean,
  ): Promise<{ ok: boolean; detail: string | null }>;
}

/** `agent create`'s arguments. Every setting left out is filled by the host, from the sender or a default. */
export function createArgs(opts: CreateOptions): string[] {
  const args = [
    "agent",
    "create",
    "--harness",
    opts.harness,
    "--model",
    opts.model,
    "--cwd",
    opts.cwd,
    "--permission-mode",
    "full_access",
    "--surface",
    "gui",
    "--json",
  ];
  if (opts.name !== undefined) args.push("--name", opts.name);
  if (opts.reasoningEffort !== undefined) args.push("--reasoning-effort", opts.reasoningEffort);
  return args;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The CLI emits one JSON result object; older builds emit NDJSON with it last. */
function parseResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["type"] === "result" || "data" in parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function dataOf(stdout: string): Record<string, unknown> | null {
  const result = parseResult(stdout);
  if (result === null) return null;
  const data = result["data"];
  return isRecord(data) ? data : null;
}

function deepFindString(node: unknown, keys: Set<string>, depth = 0): string | null {
  if (depth > 12) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindString(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  for (const [k, v] of Object.entries(node)) {
    if (keys.has(k) && typeof v === "string" && v !== "") return v;
  }
  for (const v of Object.values(node)) {
    const found = deepFindString(v, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export class RealTraycerCli implements TraycerCli {
  constructor(private readonly cfg: BenchConfig) {}

  private env(epicId: string, agentId: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      TRAYCER_EPIC_ID: epicId,
      TRAYCER_AGENT_ID: agentId,
    };
  }

  private async cli(
    epicId: string,
    agentId: string,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const res = await run(this.cfg.traycer.cliPath, args, {
      env: this.env(epicId, agentId),
      timeoutMs: 120_000,
    });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr };
  }

  async create(opts: CreateOptions): Promise<string> {
    const res = await this.cli(opts.epicId, opts.senderAgentId, createArgs(opts));
    const id = deepFindString(parseResult(res.stdout), new Set(["agentId", "childAgentId", "id"]));
    if (id === null) {
      throw new Error(`agent create returned no agent id: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return id;
  }

  async send(opts: SendOptions): Promise<{ responseId: string | null }> {
    const args = ["agent", "send", "--to", opts.to, "--message", opts.message, "--json"];
    if (opts.expectReply === true) args.push("--expect-reply");
    if (opts.responseId !== undefined) args.push("--response-id", opts.responseId);
    const res = await this.cli(opts.epicId, opts.senderAgentId, args);
    return { responseId: deepFindString(parseResult(res.stdout), new Set(["responseId"])) };
  }

  async inbox(
    epicId: string,
    agentId: string,
    after?: string | null,
  ): Promise<{ messages: InboxMessage[]; nextCursor: string | null }> {
    const args = ["agent", "inbox", "--agent-id", agentId, "--json"];
    if (after !== undefined && after !== null) args.push("--after", after);
    const res = await this.cli(epicId, agentId, args);
    const data = dataOf(res.stdout);
    const raw = data?.["messages"];
    const messages: InboxMessage[] = [];
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (!isRecord(m)) continue;
        messages.push({
          fromAgentId: deepFindString(m, new Set(["fromAgentId", "senderAgentId", "from"])),
          responseId: deepFindString(m, new Set(["responseId"])),
          text: deepFindString(m, new Set(["text", "message", "body"])) ?? "",
          createdAt: deepFindString(m, new Set(["createdAt", "timestamp"])),
          cursor: deepFindString(m, new Set(["cursor"])),
        });
      }
    }
    const nextCursor = typeof data?.["nextCursor"] === "string" ? (data["nextCursor"] as string) : null;
    return { messages, nextCursor };
  }

  async list(epicId: string, agentId: string): Promise<TraycerAgent[]> {
    const res = await this.cli(epicId, agentId, ["agent", "list", "--json"]);
    const data = dataOf(res.stdout);
    const raw = data?.["agents"];
    if (!Array.isArray(raw)) return [];
    const agents: TraycerAgent[] = [];
    for (const a of raw) {
      if (!isRecord(a)) continue;
      const id = a["id"];
      if (typeof id !== "string") continue;
      agents.push({
        id,
        parentId: typeof a["parentId"] === "string" ? a["parentId"] : null,
        active: a["active"] === true,
        harnessId: typeof a["harnessId"] === "string" ? a["harnessId"] : "",
        surface: typeof a["surface"] === "string" ? a["surface"] : "",
        title: typeof a["title"] === "string" ? a["title"] : "",
        isSelf: a["isSelf"] === true,
      });
    }
    return agents;
  }

  async transcriptPath(epicId: string, agentId: string): Promise<string | null> {
    const res = await this.cli(epicId, agentId, [
      "agent",
      "transcript",
      "--agent-id",
      agentId,
      "--json",
    ]);
    const data = dataOf(res.stdout);
    const text = typeof data?.["transcript"] === "string" ? (data["transcript"] as string) : "";
    const match = /at (\/[^\s.]+(?:\.[^\s.]+)*)/.exec(text);
    return match !== null ? (match[1] as string) : null;
  }

  async stop(epicId: string, agentId: string, childId: string, cascade: boolean): Promise<boolean> {
    const args = ["agent", "stop", "--agent-id", childId, "--json"];
    if (cascade) args.push("--cascade");
    const res = await this.cli(epicId, agentId, args);
    return res.code === 0;
  }

  async manage(
    action: "stop" | "archive",
    epicId: string,
    actingAs: string,
    targetId: string,
    cascade = false,
  ): Promise<{ ok: boolean; detail: string | null }> {
    const args = ["agent", action, "--agent-id", targetId, "--json"];
    if (cascade) args.push("--cascade");
    const res = await this.cli(epicId, actingAs, args);
    const result = parseResult(res.stdout);
    const refused = result !== null && (result["ok"] === false || "error" in result);
    const firstLine = (s: string): string | null => s.trim().split("\n")[0] || null;
    return {
      ok: res.code === 0 && !refused,
      detail:
        res.code === 0 && !refused
          ? null
          : (firstLine(res.stderr) ?? (result !== null ? JSON.stringify(result).slice(0, 300) : firstLine(res.stdout))),
    };
  }
}

/**
 * `reply-question`: the child replies on the thread, but the reply itself ends in a
 * question, which must be answered like one that arrives through the idle path.
 */
/**
 * `wrong-model`, `wrong-build`, `plan-violation` and `late-child` run as `success` does.
 * A v3 dry run then puts one child on another model or another Claude Code build, has
 * the plan turn edit a seed file, or keeps a child working after the coordinator has replied.
 */
export type DryScenario =
  | "success"
  | "question"
  | "approval"
  | "no-reply"
  | "timeout"
  | "reply-question"
  | "wrong-model"
  | "wrong-build"
  | "plan-violation"
  | "late-child";

/**
 * Scripted stand-in for the six CLI calls. Each scenario drives the runner down one
 * of the four paths the arm has to classify, with no host and no model involved.
 */
export class DryRunTraycerCli implements TraycerCli {
  private childId: string | null = null;
  turn = 0;
  /** Exposed so the chat stub can address its reply the way a real child would. */
  senderAgentId: string | null = null;
  lastResponseId: string | null = null;
  /** When each send happened, so stubbed turns can be stamped in real order. */
  readonly turnStamps: number[] = [];
  private replies: InboxMessage[] = [];
  readonly calls: { method: string; detail: string }[] = [];
  stopCalls: { childId: string; cascade: boolean }[] = [];

  constructor(
    private readonly scenario: DryScenario,
    private readonly transcriptFor: (childId: string, turn: number, scenario: DryScenario) => string,
  ) {}

  /** What each create asked for, so a test can see what the runner passed. */
  readonly created: CreateOptions[] = [];

  /** v3's build turn goes to the coordinator the plan turn created. */
  adopt(childId: string): void {
    this.childId = childId;
  }

  /** Agents the stand-in coordinator has created, listed under it. */
  descendants: TraycerAgent[] = [];
  /** How many more `list` calls each descendant reports itself working for. */
  readonly activeFor = new Map<string, number>();

  async create(opts: CreateOptions): Promise<string> {
    this.childId = randomUUID();
    this.created.push(opts);
    this.calls.push({ method: "create", detail: `${opts.epicId} cwd=${opts.cwd}` });
    return this.childId;
  }

  /** Every message sent, whole, in order. */
  readonly sent: string[] = [];

  async send(opts: SendOptions): Promise<{ responseId: string | null }> {
    this.sent.push(opts.message);
    // A real send takes far longer than a millisecond. Without this the stub can
    // record two sends in the same tick, and the reply cutoff -- which is what stops
    // an earlier reply settling a later message -- has no gap to work with.
    await new Promise((r) => setTimeout(r, 25));
    this.turn += 1;
    this.calls.push({ method: "send", detail: opts.message.slice(0, 60) });
    const responseId = opts.responseId ?? `resp-${this.childId}`;
    this.senderAgentId = opts.senderAgentId;
    this.lastResponseId = responseId;
    this.turnStamps.push(Date.now());

    if (this.scenario === "timeout") return { responseId };
    if (this.scenario === "no-reply") return { responseId };

    // The question and approval scenarios withhold the reply on their first turn so the
    // idle rule has to classify the transcript tail and send the scripted answer.
    if ((this.scenario === "question" || this.scenario === "approval") && this.turn === 1) return { responseId };

    this.replies.push({
      fromAgentId: this.childId,
      responseId,
      text: "Done. Plan written and the decisions are recorded.",
      createdAt: new Date().toISOString(),
      cursor: `cursor-${this.turn}`,
    });
    return { responseId };
  }

  async inbox(): Promise<{ messages: InboxMessage[]; nextCursor: string | null }> {
    this.calls.push({ method: "inbox", detail: `${this.replies.length} pending` });
    const messages = this.replies;
    this.replies = [];
    return { messages, nextCursor: messages[messages.length - 1]?.cursor ?? null };
  }

  async list(): Promise<TraycerAgent[]> {
    this.calls.push({ method: "list", detail: this.scenario });
    const active = this.scenario === "timeout";
    return [
      {
        id: this.childId ?? "unknown",
        parentId: "sender",
        active,
        harnessId: "claude",
        surface: "gui",
        title: "dry-run child",
        isSelf: false,
      },
      ...this.descendants.map((a) => {
        const left = this.activeFor.get(a.id) ?? 0;
        if (left > 0) this.activeFor.set(a.id, left - 1);
        return { ...a, active: a.active || left > 0 };
      }),
    ];
  }

  async transcriptPath(): Promise<string | null> {
    this.calls.push({ method: "transcript", detail: `turn ${this.turn}` });
    return this.transcriptFor(this.childId ?? "unknown", this.turn, this.scenario);
  }

  async stop(_epicId: string, _agentId: string, childId: string, cascade: boolean): Promise<boolean> {
    this.calls.push({ method: "stop", detail: `cascade=${cascade}` });
    this.stopCalls.push({ childId, cascade });
    return true;
  }

  /** Every stop and archive, in order, with the identity it ran as. */
  manageCalls: { action: "stop" | "archive"; actingAs: string; targetId: string; cascade: boolean }[] = [];
  /** Archives to refuse before accepting one, as the host does while an agent is still settling. */
  refuseArchives = 0;

  async manage(
    action: "stop" | "archive",
    _epicId: string,
    actingAs: string,
    targetId: string,
    cascade = false,
  ): Promise<{ ok: boolean; detail: string | null }> {
    this.calls.push({ method: action, detail: `${targetId} as ${actingAs}` });
    this.manageCalls.push({ action, actingAs, targetId, cascade });
    if (action === "archive" && this.refuseArchives > 0) {
      this.refuseArchives -= 1;
      return { ok: false, detail: "agent is still working; stop it first" };
    }
    return { ok: true, detail: null };
  }
}
