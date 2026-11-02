import fs from "node:fs";
import path from "node:path";
import type { BenchConfig, NativeUsage } from "./types.ts";
import { run } from "./util.ts";

/**
 * Reads the host's own chat store for one agent. `traycer agent transcript` returns
 * prose only, so the per-turn facts this arm needs -- which credential authenticated
 * the turn, which tools ran, which skills loaded -- are only available here.
 * This is an internal store and not a contract, so every field is optional and a
 * failure degrades to "unknown" rather than to a wrong number.
 */

export interface AgentMessageSend {
  receiverAgentId: string | null;
  responseId: string | null;
  message: string;
  expectReply: boolean;
  status: string;
}

export interface TraycerTurn {
  messageId: string;
  turnId: string | null;
  role: string;
  timestamp: number | null;
  envCredentialVar: string | null;
  hasEnvCredentialField: boolean;
  text: string;
  /** `at` is the block's own start time, which the message timestamp is not. */
  toolCalls: { name: string; input: Record<string, string>; at: number | null }[];
  skillLoads: string[];
  /** Agent-to-agent sends this turn made; the child's reply is one of these. */
  sends: AgentMessageSend[];
  usage: Record<string, number> | null;
}

export const SEND_TOOL = "mcp__traycer_a2a__traycer_send_message";

/**
 * How many turns the chat ran, and what that count was derived from. The host
 * prunes its own history, so the strongest available source is used and named
 * rather than one source being trusted unconditionally.
 */
export type TurnCountSource =
  | "turnCompletedEvents"
  | "assistantTurnIds"
  | "assistantMessages"
  | "none";

export interface TraycerChat {
  chatId: string;
  available: boolean;
  note: string | null;
  turns: TraycerTurn[];
  turnCount: number;
  turnCountSource: TurnCountSource;
  /**
   * The Claude Code sessions the host ran this chat in, from its own session chain.
   * A ledger row is the chat's own when one of these sessions carries its message id.
   */
  claudeSessionIds?: string[];
  /**
   * The Claude Code sessions the chat's own message rows anchor. The host squashes
   * older ops, so a session can be gone from the op log while its messages still name it.
   */
  anchoredSessionIds?: string[];
}

export function chatDbPath(cfg: BenchConfig, epicId: string): string {
  return path.join(
    path.dirname(cfg.traycer.epicsRoot),
    "host",
    "epic-state",
    epicId,
    "chat",
    "chat.db",
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function normaliseBlocks(blocks: unknown): {
  text: string;
  toolCalls: TraycerTurn["toolCalls"];
  skillLoads: string[];
  sends: AgentMessageSend[];
} {
  const texts: string[] = [];
  const toolCalls: TraycerTurn["toolCalls"] = [];
  const skillLoads: string[] = [];
  const sends: AgentMessageSend[] = [];
  if (!Array.isArray(blocks)) return { text: "", toolCalls, skillLoads, sends };

  for (const raw of blocks) {
    if (!isRecord(raw)) continue;
    const type = raw["type"];
    if (type === "text") {
      const t = str(raw["content"]) ?? str(raw["text"]);
      if (t !== null) texts.push(t);
      continue;
    }
    if (type !== "tool_call") continue;

    const name = str(raw["toolName"]) ?? "";
    const input: Record<string, string> = {};
    const detail = raw["inputDetail"];
    if (isRecord(detail)) {
      // `kind: "fields"` puts the arguments in entries[]; `kind: "command"` puts the
      // command straight on the detail. Only the first shape was read before, so
      // every Bash call fell through to inputSummary — which is **truncated** at
      // about 78 characters with an ellipsis. Arm T's shell commands reached the
      // audit and every detector cut off mid-word.
      if (Array.isArray(detail["entries"])) {
        for (const entry of detail["entries"]) {
          if (!isRecord(entry)) continue;
          const key = str(entry["key"]);
          const value = str(entry["value"]);
          if (key !== null && value !== null) input[key] = value;
        }
      }
      for (const [key, value] of Object.entries(detail)) {
        if (key === "entries" || key === "kind") continue;
        const text = str(value);
        if (text !== null && input[key] === undefined) input[key] = text;
      }
    }
    const summary = str(raw["inputSummary"]);
    if (summary !== null && Object.keys(input).length === 0) input["inputSummary"] = summary;

    // The block's own clock. One assistant message can hold a whole phase's calls —
    // 25 of them on the first live arm-T attempt — so the message timestamp is the
    // moment the phase settled, not the moment any one call ran.
    const startedAt = raw["startedAt"] ?? raw["timestamp"];
    toolCalls.push({
      name,
      input,
      at: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null,
    });
    if (name === "Skill") {
      const skill = input["skill"] ?? input["name"] ?? summary ?? "";
      if (skill !== "") skillLoads.push(skill);
    }

    const send = raw["agentMessageSend"];
    if (isRecord(send)) {
      sends.push({
        receiverAgentId: str(send["receiverAgentId"]),
        responseId: str(send["responseId"]),
        message: str(send["message"]) ?? "",
        expectReply: send["expectReply"] === true,
        status: str(raw["status"]) ?? "",
      });
    }
  }
  return { text: texts.join("\n"), toolCalls, skillLoads, sends };
}

function numbers(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value === "number" && Number.isFinite(value)) out[k] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Copies the whole store, not just the main file. The host keeps it in WAL mode, so
 * everything written since the last checkpoint lives in `-wal` — which is exactly
 * where the newest turns are, including the send block that ends a phase. Copying
 * `chat.db` alone reads a stale snapshot that silently omits them.
 *
 * The WAL is copied first on purpose: if a checkpoint races the copy, a frame can
 * then end up in both files, which is harmless, rather than in neither, which loses
 * data. The copy stays as evidence; nothing is deleted.
 */
export function copyStore(dbPath: string, scratchDir: string, chatId: string): string | null {
  const copy = path.join(scratchDir, `chat-${chatId}.db`);
  try {
    fs.mkdirSync(scratchDir, { recursive: true });
    for (const suffix of ["-wal", "-shm", ""]) {
      const src = `${dbPath}${suffix}`;
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, `${copy}${suffix}`);
    }
  } catch {
    return null;
  }
  return fs.existsSync(copy) ? copy : null;
}

interface OpRow {
  seq: number;
  op_json: string;
}

interface MessageRow {
  message_id: string;
  insert_seq: number;
  last_seq: number;
  body: string;
}

interface EventRow {
  event_id: string;
  insert_seq: number;
  last_seq: number;
  body: string;
}

function quote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * `null` means the query did not run — an older store without the table, most
 * often — which is a different thing from a table that is there and empty, and the
 * difference decides whether a source counts as read at all.
 */
async function queryJson<T>(copy: string, sql: string): Promise<T[] | null> {
  const res = await run("sqlite3", ["-json", copy, sql]);
  if (res.code !== 0) return null;
  if (res.stdout.trim() === "") return [];
  try {
    const rows = JSON.parse(res.stdout) as T[];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/**
 * The op log is the chat's running record, but it is not permanent: the host
 * compacts it, and one chat that held 156 ops came back from a host migration with
 * 42 — two `Turn completed` events where there had been ten. So it is one of two
 * sources, not the only one.
 */
async function readOps(copy: string, chatId: string): Promise<OpRow[] | null> {
  return queryJson<OpRow>(
    copy,
    `select seq, op_json from chat_op_log where chat_id = ${quote(chatId)} order by seq;`,
  );
}

/**
 * The compacted record: one row per message holding its full body. It survives the
 * pruning the op log does not, and a migrated chat keeps its bodies here even where
 * the log lost states. `removed_seq` marks a message the chat dropped.
 */
async function readMessageRows(copy: string, chatId: string): Promise<MessageRow[] | null> {
  return queryJson<MessageRow>(
    copy,
    `select message_id, insert_seq, last_seq, body from chat_message
       where chat_id = ${quote(chatId)} and removed_seq is null order by insert_seq;`,
  );
}

async function readEventRows(copy: string, chatId: string): Promise<EventRow[] | null> {
  return queryJson<EventRow>(
    copy,
    `select event_id, insert_seq, last_seq, body from chat_event
       where chat_id = ${quote(chatId)} order by insert_seq;`,
  );
}

async function readHeadSettings(copy: string, chatId: string): Promise<unknown> {
  const rows = await queryJson<{ settings_json: string | null }>(
    copy,
    `select settings_json from chat_projection_head where chat_id = ${quote(chatId)};`,
  );
  const raw = rows?.[0]?.settings_json;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

type Origin = "opLog" | "table";

interface Candidate {
  seq: number;
  origin: Origin;
  body: Record<string, unknown>;
}

/**
 * Which of two states of the same record is the later one.
 *
 * Sequences are comparable only inside the op log's own space. A row written while
 * the host migrated an old chat carries a synthetic negative sequence and holds the
 * compaction output, which is the final state by construction — so a surviving op at
 * some high positive sequence is not newer than it, it is the same state reached by
 * another route. Otherwise the higher sequence wins, and a tie goes to the table,
 * which is only ever written from the op.
 */
function later(a: Candidate, b: Candidate): Candidate {
  const aMigrated = a.origin === "table" && a.seq < 0;
  const bMigrated = b.origin === "table" && b.seq < 0;
  if (aMigrated !== bMigrated) return aMigrated ? a : b;
  if (a.seq !== b.seq) return a.seq > b.seq ? a : b;
  return a.origin === "table" ? a : b;
}

interface RebuiltChat {
  bodies: Record<string, unknown>[];
  settings: unknown;
  turnsCompleted: number;
  sources: string[];
}

function isTurnCompleted(event: Record<string, unknown>): boolean {
  if (event["type"] === "turn.completed") return true;
  const message = str(event["message"]);
  return message !== null && message.startsWith("Turn completed");
}

/**
 * Rebuilds a chat from both stores at once, keyed by id, so neither has to be
 * complete on its own: the op log carries whatever has happened since the last fold,
 * the tables carry whatever compaction kept.
 *
 * `message.upsert` carries a full snapshot of the message each time, not a delta
 * (block counts on the fixture grow 0 → 13 → 15 → 23 → 23 for one id), so one state
 * per id wins outright rather than being merged. Blocks are still deduped by blockId
 * in case a future build starts appending. Order is first appearance, which is the
 * order the conversation happened in; the migration's negative sequences keep
 * migrated messages ahead of anything added since, which is also chronological.
 */
function unionChat(
  ops: OpRow[] | null,
  messages: MessageRow[] | null,
  events: EventRow[] | null,
): RebuiltChat {
  const byMessage = new Map<string, Candidate>();
  const byEvent = new Map<string, Candidate>();
  const messageOrder = new Map<string, number>();
  const anonymousEvents: Record<string, unknown>[] = [];
  const sources: string[] = [];
  let settings: unknown = undefined;

  const offer = (map: Map<string, Candidate>, key: string, candidate: Candidate): void => {
    const existing = map.get(key);
    map.set(key, existing === undefined ? candidate : later(existing, candidate));
  };
  const first = (key: string, seq: number): void => {
    const prev = messageOrder.get(key);
    if (prev === undefined || seq < prev) messageOrder.set(key, seq);
  };

  if (ops !== null && ops.length > 0) {
    sources.push("chat_op_log");
    for (const row of ops) {
      let op: Record<string, unknown>;
      try {
        op = JSON.parse(row.op_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = op["type"];

      if (type === "message.upsert") {
        const messageId = str(op["messageId"]);
        const message = op["message"];
        if (messageId === null || !isRecord(message)) continue;
        first(messageId, row.seq);
        offer(byMessage, messageId, { seq: row.seq, origin: "opLog", body: message });
        continue;
      }

      if (type === "chat.metadata") {
        const patch = op["patch"];
        if (isRecord(patch) && isRecord(patch["settings"])) {
          const value = (patch["settings"] as Record<string, unknown>)["value"];
          if (isRecord(value)) settings = value;
        }
        continue;
      }

      if (type === "event.append") {
        const event = op["event"];
        if (!isRecord(event)) continue;
        const eventId = str(op["eventId"]) ?? str(event["eventId"]);
        // An op with no id cannot be matched against the event table, so it is
        // counted on its own rather than dropped.
        if (eventId === null) anonymousEvents.push(event);
        else offer(byEvent, eventId, { seq: row.seq, origin: "opLog", body: event });
      }
    }
  }

  if (messages !== null && messages.length > 0) {
    sources.push("chat_message");
    for (const row of messages) {
      let body: unknown;
      try {
        body = JSON.parse(row.body);
      } catch {
        continue;
      }
      if (!isRecord(body)) continue;
      first(row.message_id, row.insert_seq);
      offer(byMessage, row.message_id, { seq: row.last_seq, origin: "table", body });
    }
  }

  if (events !== null && events.length > 0) {
    sources.push("chat_event");
    for (const row of events) {
      let body: unknown;
      try {
        body = JSON.parse(row.body);
      } catch {
        continue;
      }
      if (!isRecord(body)) continue;
      offer(byEvent, row.event_id, { seq: row.last_seq, origin: "table", body });
    }
  }

  const bodies = [...byMessage.entries()]
    .sort((a, b) => (messageOrder.get(a[0]) ?? 0) - (messageOrder.get(b[0]) ?? 0))
    .map(([, candidate]) => dedupeBlocks(candidate.body));

  const turnsCompleted =
    [...byEvent.values()].filter((c) => isTurnCompleted(c.body)).length +
    anonymousEvents.filter(isTurnCompleted).length;

  return { bodies, settings, turnsCompleted, sources };
}

function dedupeBlocks(body: Record<string, unknown>): Record<string, unknown> {
  const blocks = body["blocks"];
  if (!Array.isArray(blocks)) return body;
  const seen = new Set<string>();
  const kept: unknown[] = [];
  for (const block of blocks) {
    const id = isRecord(block) ? str(block["blockId"]) : null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    kept.push(block);
  }
  return { ...body, blocks: kept };
}

export interface ChatSettings {
  harnessId: string | null;
  model: string | null;
  permissionMode: string | null;
  reasoningEffort?: string | null;
}

/**
 * A sender's run configuration. The harness matters because a `claude` sender is
 * routed by the same provider override as the arm itself: its wake would reach the
 * proxy and land in the attempt's ledger.
 */
export async function readChatSettings(
  cfg: BenchConfig,
  epicId: string,
  chatId: string,
  scratchDir: string,
): Promise<ChatSettings | null> {
  return readChatSettingsAt(chatDbPath(cfg, epicId), chatId, scratchDir);
}

/** The same, from a store by path: a v3 attempt reads every agent's settings from the copy it kept. */
export async function readChatSettingsAt(dbPath: string, chatId: string, scratchDir: string): Promise<ChatSettings | null> {
  if (!fs.existsSync(dbPath)) return null;
  const copy = copyStore(dbPath, scratchDir, chatId);
  if (copy === null) return null;

  // Settings arrive as `chat.metadata` ops, and those are read first because a
  // sender reconfigured a moment ago has the new harness there before anywhere else.
  // The head row is the fallback: it holds the folded settings, and it is where they
  // live at all once the ops that set them have been compacted away.
  const ops = await readOps(copy, chatId);
  let settings: unknown = ops === null ? undefined : unionChat(ops, null, null).settings;
  if (!isRecord(settings)) settings = await readHeadSettings(copy, chatId);
  if (!isRecord(settings)) return null;
  return {
    harnessId: str(settings["harnessId"]),
    model: str(settings["model"]),
    permissionMode: str(settings["permissionMode"]),
    reasoningEffort: str(settings["reasoningEffort"]),
  };
}

export async function readChat(
  cfg: BenchConfig,
  epicId: string,
  chatId: string,
  scratchDir: string,
): Promise<TraycerChat> {
  return readChatAt(chatDbPath(cfg, epicId), chatId, scratchDir);
}

/**
 * Reads a store by path, so an attempt can be re-read from the copy kept in its own
 * directory long after the live epic has moved on or been archived.
 */
export async function readChatAt(
  dbPath: string,
  chatId: string,
  scratchDir: string,
): Promise<TraycerChat> {
  const unavailable = (note: string): TraycerChat => ({
    chatId,
    available: false,
    note,
    turns: [],
    turnCount: 0,
    turnCountSource: "none",
  });

  if (!fs.existsSync(dbPath)) return unavailable(`no chat store at ${dbPath}`);

  const copy = copyStore(dbPath, scratchDir, chatId);
  if (copy === null) return unavailable("chat store could not be copied");

  const ops = await readOps(copy, chatId);
  const built = unionChat(ops, await readMessageRows(copy, chatId), await readEventRows(copy, chatId));
  if (built.sources.length === 0) {
    return unavailable("no readable op log, message table or event table");
  }

  const turns: TraycerTurn[] = [];
  for (const body of built.bodies) {
    const { text, toolCalls, skillLoads, sends } = normaliseBlocks(body["blocks"]);
    turns.push({
      messageId: str(body["messageId"]) ?? "",
      turnId: str(body["turnId"]),
      role: str(body["role"]) ?? "",
      timestamp: typeof body["timestamp"] === "number" ? body["timestamp"] : null,
      envCredentialVar: str(body["envCredentialVar"]),
      hasEnvCredentialField: "envCredentialVar" in body,
      text,
      toolCalls,
      skillLoads,
      sends,
      usage: numbers(body["usage"]),
    });
  }

  // Events are the host's own count and are preferred, but compaction can take them
  // while leaving the messages, so a distinct assistant turnId stands in before the
  // weakest reading — one turn per assistant message — is used.
  const assistant = turns.filter((t) => t.role === "assistant" || t.usage !== null);
  const turnIds = new Set(assistant.map((t) => t.turnId).filter((id): id is string => id !== null));
  let turnCount = built.turnsCompleted;
  let turnCountSource: TurnCountSource = "turnCompletedEvents";
  if (turnCount === 0) {
    if (turnIds.size > 0) {
      turnCount = turnIds.size;
      turnCountSource = "assistantTurnIds";
    } else {
      turnCount = assistant.length;
      turnCountSource = turnCount > 0 ? "assistantMessages" : "none";
    }
  }

  return {
    chatId,
    available: true,
    note: `rebuilt from ${built.sources.join(" + ")}; turn count from ${turnCountSource}`,
    turns,
    turnCount,
    turnCountSource,
    claudeSessionIds: claudeSessionIdsIn(ops ?? [], chatId),
    anchoredSessionIds: claudeSessionIdsInMessages((await readAnchorRows(copy, chatId)) ?? []),
  };
}

interface AnchorRow {
  body: string;
  fold_facts?: string | null;
  harness_ids?: string | null;
}

/** Every message row of the chat, removed ones included: a removed message's session still ran. */
async function readAnchorRows(copy: string, chatId: string): Promise<AnchorRow[] | null> {
  const where = `where chat_id = ${quote(chatId)} order by insert_seq`;
  return (
    (await queryJson<AnchorRow>(copy, `select body, fold_facts, harness_ids from chat_message ${where};`)) ??
    (await queryJson<AnchorRow>(copy, `select body from chat_message ${where};`))
  );
}

/**
 * Every `sessionAnchor` on the claude harness in a chat's message rows, from the body
 * and the folded facts alike. The anchor's own harness decides; a row's `harness_ids`
 * only stands in when the anchor names none, since a row the coordinator received
 * from a codex sender carries `["codex"]` over a claude anchor.
 */
export function claudeSessionIdsInMessages(rows: AnchorRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    let rowHarnesses: unknown = null;
    try {
      rowHarnesses = typeof row.harness_ids === "string" ? JSON.parse(row.harness_ids) : null;
    } catch {
      rowHarnesses = null;
    }
    for (const text of [row.body, row.fold_facts]) {
      if (typeof text !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const anchor = isRecord(parsed) ? parsed["sessionAnchor"] : null;
      if (!isRecord(anchor)) continue;
      const id = str(anchor["sessionId"]);
      const harness = str(anchor["harnessId"]);
      const claude = harness !== null ? harness === "claude" : Array.isArray(rowHarnesses) && rowHarnesses.includes("claude");
      if (id !== null && claude && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** v3's roster: the op log's sessions, then any only the message rows still name. */
export function rosterSessionIds(chat: TraycerChat): string[] {
  const ids = [...(chat.claudeSessionIds ?? [])];
  for (const id of chat.anchoredSessionIds ?? []) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * Every `activeSessionChain` on the claude harness in the chat's own ops. The copy of
 * a store also holds other chats' ops, its sender's above all, so the query is scoped
 * to the chat and each op's own `chatId` is checked as well.
 */
export function claudeSessionIdsIn(ops: { op_json: string }[], chatId?: string): string[] {
  const ids: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 20) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    const chain = node["activeSessionChain"];
    if (isRecord(chain) && chain["harnessId"] === "claude") {
      const id = str(chain["sessionId"]);
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  for (const op of ops) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(op.op_json);
    } catch {
      continue;
    }
    if (chatId !== undefined && isRecord(parsed) && typeof parsed["chatId"] === "string" && parsed["chatId"] !== chatId) {
      continue;
    }
    visit(parsed, 0);
  }
  return ids;
}

/** Assistant turns only: a user message carries no credential and no usage. */
export function assistantTurns(chat: TraycerChat): TraycerTurn[] {
  return chat.turns.filter((t) => t.role === "assistant" || t.usage !== null);
}


/**
 * Arm T's native counter, read from the chat store — **the child's own chat only**.
 *
 * The two kinds of number on a usage record have **different bases**, verified on
 * the first live attempt: the token fields are a snapshot of the final API call in
 * that turn (cacheCreationInputTokens even goes *down* between turns), while
 * `costUsd` is cumulative and covers every internal call — on the same record it is
 * 50-60x what those token fields price out to. So the tokens are not comparable
 * with a per-call proxy ledger and are reported as null rather than as a number
 * that would read 4x low; `costUsd` is taken as the last value per agent, since it
 * is cumulative, and summed across the agents in the epic.
 */
export const TRAYCER_NATIVE_SOURCE =
  "traycer chat store, child agent's final cumulative costUsd; token fields are final-call snapshots and are not comparable";

export function storeUsage(chats: TraycerChat[]): NativeUsage | null {
  let usd: number | null = null;
  for (const chat of chats) {
    const withUsage = assistantTurns(chat).filter((t) => t.usage !== null);
    const last = withUsage[withUsage.length - 1];
    const cost = last?.usage?.["costUsd"];
    if (typeof cost === "number") usd = (usd ?? 0) + cost;
  }
  if (usd === null) return null;
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    usd,
    source: TRAYCER_NATIVE_SOURCE,
  };
}

/** One JSONL record per tool call, in the shape `rig audit` already parses. */
export function toAuditTranscript(chat: TraycerChat): string {
  const lines: string[] = [];
  for (const turn of chat.turns) {
    for (const call of turn.toolCalls) {
      // `at` lets one timeline parser serve both arms: arm C's session jsonl already
      // timestamps every record, and the audit needs an ordering in time.
      // The block's own start time, falling back to the message's — and the line says
      // which, because the fallback collapses a whole phase onto one instant.
      const at = call.at ?? turn.timestamp;
      lines.push(
        JSON.stringify({
          type: "tool_use",
          name: call.name,
          input: call.input,
          turnId: turn.turnId,
          at: at === null ? null : new Date(at).toISOString(),
          atSource: call.at !== null ? "toolCallStartedAt" : "messageTimestamp",
        }),
      );
    }
    if (turn.text !== "") {
      lines.push(
        JSON.stringify({
          type: turn.role,
          text: turn.text,
          turnId: turn.turnId,
          at: turn.timestamp === null ? null : new Date(turn.timestamp).toISOString(),
        }),
      );
    }
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}


export interface DetectedReply {
  message: string;
  at: number | null;
  messageId: string;
  responseId: string | null;
}

/**
 * The child's own record of replying, read from its chat store rather than from
 * the sender's inbox. A GUI sender's runtime drains its inbox before the CLI can
 * see it, so the send block is the only place the reply is reliably observable.
 * A responseId of null matches any thread, for callers that did not open one.
 *
 * `sinceMs` is what keeps a second message on the same thread honest: replies to
 * the previous message are still in the store and would otherwise settle it
 * instantly. A turn with no timestamp is not filtered out, since dropping it
 * would lose a real reply.
 */
export function findReply(
  chat: TraycerChat,
  senderAgentId: string,
  responseId: string | null,
  sinceMs = 0,
): DetectedReply | null {
  for (const turn of chat.turns) {
    if (turn.timestamp !== null && turn.timestamp < sinceMs) continue;
    for (const send of turn.sends) {
      if (send.status !== "completed") continue;
      if (send.receiverAgentId !== senderAgentId) continue;
      if (responseId !== null && send.responseId !== responseId) continue;
      return {
        message: send.message,
        at: turn.timestamp,
        messageId: turn.messageId,
        responseId: send.responseId,
      };
    }
  }
  return null;
}

/** The last reply since `sinceMs`, where a turn may hold several: the latest is the one a question is read from. */
export function findLatestReply(
  chat: TraycerChat,
  senderAgentId: string,
  responseId: string | null,
  sinceMs = 0,
): DetectedReply | null {
  let latest: DetectedReply | null = null;
  for (const turn of chat.turns) {
    if (turn.timestamp !== null && turn.timestamp < sinceMs) continue;
    for (const send of turn.sends) {
      if (send.status !== "completed" || send.receiverAgentId !== senderAgentId) continue;
      if (responseId !== null && send.responseId !== responseId) continue;
      latest = { message: send.message, at: turn.timestamp, messageId: turn.messageId, responseId: send.responseId };
    }
  }
  return latest;
}
