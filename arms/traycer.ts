import fs from "node:fs";
import path from "node:path";
import type { ArmContext } from "./types.ts";
import type { Phase, PhaseRecord, ScriptedReply, TraycerConfig, TraycerPhaseDetail } from "../src/types.ts";
import type { TraycerCli } from "../src/traycer-cli.ts";
import { transcriptPath } from "../src/paths.ts";
import { detectQuestion } from "../src/prompts.ts";
import {
  assistantTurns,
  storeUsage,
  findLatestReply,
  findReply,
  readChat,
  toAuditTranscript,
} from "../src/traycer-store.ts";
import type { TraycerChat } from "../src/traycer-store.ts";
import { nowIso } from "../src/util.ts";

export interface TraycerArmContext extends ArmContext {
  cli: TraycerCli;
  /** Dry runs stub the chat store, which only the host writes. */
  readChatOverride?: (epicId: string, chatId: string) => Promise<TraycerChat>;
  /** v3's build turn: the coordinator the plan turn created gets the message, in the same epic. */
  coordinatorId?: string;
  /** The attempt's one epic and its sender. */
  epic: { epicId: string; senderAgentId: string };
  /**
   * v3's build turn: a reply settles the turn only once every agent under the
   * coordinator has gone idle too, so children are never cut off mid-ticket.
   */
  waitForSubtree?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tail(text: string, n = 800): string {
  return text.trimEnd().slice(-n);
}

/**
 * What the sender sends the child, in order. Phase A's prompt carries the skill
 * prefix and is followed by the ticket-breakdown message, but only where the config
 * sets them: an empty setting sends nothing, so a protocol with neither sends the
 * prompt alone, as predeclared, rather than a prompt with a leading space and then
 * an empty message the child has to answer.
 */
export function phaseMessages(t: TraycerConfig, phase: Phase, prompt: string): string[] {
  if (phase !== "A") return [prompt];
  const first = t.skillPrefixPhaseA.trim() === "" ? prompt : `${t.skillPrefixPhaseA} ${prompt}`;
  return [first, t.ticketBreakdownMessage].filter((m) => m.trim() !== "");
}

export async function runTraycer(ctx: TraycerArmContext): Promise<PhaseRecord> {
  const t = ctx.cfg.traycer;
  const { epicId, senderAgentId } = ctx.epic;

  const launchedAt = Date.now();
  const deadline = launchedAt + ctx.cfg.phaseTimeoutMs;
  const replies: ScriptedReply[] = [];
  const idleClassifications: TraycerPhaseDetail["idleClassifications"] = [];
  const responseIds: string[] = [];

  let childId: string | null = null;
  let timedOut = false;
  let cascadeStopped = false;
  let unanswered = false;
  let completedBy: TraycerPhaseDetail["completedBy"] = "reply";
  let cursor: string | null = null;

  const readChatFn = ctx.readChatOverride ?? ((e: string, c: string) => readChat(ctx.cfg, e, c, ctx.paths.dir));

  const messages = phaseMessages(t, ctx.phase, ctx.prompt);

  childId = ctx.coordinatorId ?? await ctx.cli.create({
    epicId,
    senderAgentId,
    harness: t.harness,
    model: ctx.cfg.model.armModelRef["T"] ?? ctx.cfg.model.id,
    cwd: ctx.paths.work,
    name: `bench-${ctx.paths.attemptId}-${ctx.phase}`,
    ...(ctx.cfg.effort !== undefined ? { reasoningEffort: ctx.cfg.effort } : {}),
  });

  let scriptedCount = 0;
  let replyAt: number | null = null;
  const settleLog: NonNullable<TraycerPhaseDetail["settles"]> = [];

  outer: for (const [index, message] of messages.entries()) {
    let outgoing = message;
    let responseId: string | undefined;

    for (;;) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break outer;
      }

      const sentAt = Date.now();
      const sent = await ctx.cli.send({
        epicId,
        senderAgentId,
        to: childId,
        message: outgoing,
        expectReply: true,
        ...(responseId !== undefined ? { responseId } : {}),
      });
      if (sent.responseId !== null) {
        responseId = sent.responseId;
        if (!responseIds.includes(sent.responseId)) responseIds.push(sent.responseId);
      }

      const settled = await awaitSettle(
        ctx,
        epicId,
        senderAgentId,
        childId,
        deadline,
        cursor,
        responseId ?? null,
        readChatFn,
        sentAt,
        ctx.waitForSubtree === true,
      );
      cursor = settled.cursor;
      if (settled.log !== undefined) settleLog.push(settled.log);
      if (settled.replyAt !== undefined && settled.replyAt !== null) replyAt = settled.replyAt;

      if (settled.kind === "timeout") {
        timedOut = true;
        break outer;
      }
      if (settled.kind === "reply") {
        // A reply that ends in a question is still a question, answered by the same
        // rule as one that arrives through the idle path.
        const replyText = settled.replyText ?? "";
        const detection = detectQuestion(replyText);
        if (!detection.isQuestion || scriptedCount >= t.maxScriptedReplies) {
          if (detection.isQuestion) {
            unanswered = true;
            completedBy = "unansweredQuestion";
            break outer;
          }
          break;
        }
        idleClassifications.push({
          at: nowIso(),
          verdict: detection.kind,
          transcriptSpan: tail(replyText),
        });
        scriptedCount += 1;
        const replyBack = ctx.policy[detection.kind];
        replies.push({
          kind: detection.kind,
          sentAt: nowIso(),
          triggeringText: tail(replyText),
          replyText: replyBack,
        });
        outgoing = replyBack;
        continue;
      }

      // Idle with no reply: one fixed rule decides from the transcript tail.
      const chat = await readChatFn(epicId, childId);
      const lastText = lastAssistantText(chat);
      const detection = detectQuestion(lastText);
      if (!detection.isQuestion) {
        idleClassifications.push({
          at: nowIso(),
          verdict: "finishedWithoutReply",
          transcriptSpan: tail(lastText),
        });
        completedBy = "finishedWithoutReply";
        break;
      }

      idleClassifications.push({
        at: nowIso(),
        verdict: detection.kind,
        transcriptSpan: tail(lastText),
      });

      if (scriptedCount >= t.maxScriptedReplies) {
        unanswered = true;
        completedBy = "unansweredQuestion";
        break outer;
      }
      scriptedCount += 1;
      const replyText = ctx.policy[detection.kind];
      replies.push({
        kind: detection.kind,
        sentAt: nowIso(),
        triggeringText: tail(lastText),
        replyText,
      });
      outgoing = replyText;
    }

    if (index === messages.length - 1 && completedBy === "reply") completedBy = "reply";
  }

  if (timedOut) {
    completedBy = "timeout";
    cascadeStopped = await ctx.cli.stop(epicId, senderAgentId, childId, true);
  }

  const whole = await readChatFn(epicId, childId);
  // A reused coordinator's chat also holds the plan turn; this phase is what came after it.
  const chat = ctx.coordinatorId === undefined ? whole : sinceLaunch(whole, launchedAt);
  // The child's send block carries the host's own timestamp for the reply, which is
  // when the phase actually settled; polling only discovers it some interval later.
  // Waiting for the subtree, the turn settles when the last agent went idle, not at the reply.
  const settledAt =
    ctx.waitForSubtree !== true &&
    completedBy === "reply" && replyAt !== null && replyAt > launchedAt && replyAt <= Date.now()
      ? replyAt
      : Date.now();

  fs.mkdirSync(ctx.paths.transcripts, { recursive: true });
  const transcript = transcriptPath(ctx.paths, ctx.phase, "jsonl");
  fs.writeFileSync(transcript, toAuditTranscript(chat));
  const stderrPath = transcriptPath(ctx.paths, ctx.phase, "stderr.txt");
  fs.writeFileSync(stderrPath, chat.note ?? "");

  const turns = assistantTurns(chat);
  const envCredentialVars = turns.map((t2) => t2.envCredentialVar);
  // Absence is the positive claim here: no envCredentialVar means the turn ran on
  // the signed-in profile, which is the channel every arm shares.
  const expectSignedIn = ctx.cfg.auth.mode === "subscription";
  const authChannelOk =
    chat.available &&
    turns.length > 0 &&
    envCredentialVars.every((v) => (expectSignedIn ? v === null : v === "ANTHROPIC_API_KEY"));
  const skillLoads = [...new Set(turns.flatMap((t2) => t2.skillLoads))];

  const detail: TraycerPhaseDetail = {
    epicId,
    senderAgentId,
    childAgentId: childId,
    responseIds,
    completedBy,
    idleClassifications,
    envCredentialVars,
    authChannelOk,
    cascadeStopped,
    skillLoads,
    ...(ctx.cfg.attributeCalls === true ? { claudeSessionIds: whole.claudeSessionIds ?? [] } : {}),
    ...(ctx.coordinatorId !== undefined ? { reusedCoordinator: true } : {}),
    ...(ctx.waitForSubtree === true ? { settles: settleLog } : {}),
    activeAtSettle: await activeBelow(ctx.cli, epicId, senderAgentId, childId),
  };

  return {
    phase: ctx.phase,
    arm: "T",
    dryRun: ctx.dryRun,
    launchedAt: new Date(launchedAt).toISOString(),
    settledAt: new Date(settledAt).toISOString(),
    wallClockMs: settledAt - launchedAt,
    exitCode: timedOut ? null : 0,
    timedOut,
    sessionId: childId,
    resolvedModelId: ctx.cfg.model.armModelRef["T"] ?? ctx.cfg.model.id,
    turns: chat.turnCount,
    nativeUsage: storeUsage([chat]),
    nativeParseNote: chat.available ? null : chat.note,
    scriptedReplies: replies,
    unansweredQuestion: unanswered,
    harnessCommand: [
      t.cliPath,
      "agent",
      "create",
      "--harness",
      t.harness,
      ...(ctx.cfg.effort !== undefined ? ["--reasoning-effort", ctx.cfg.effort] : []),
    ],
    transcriptPath: transcript,
    stderrPath,
    infrastructureSignal: null,
    traycer: detail,
  };
}

/** The turns from `launchedAt` on; a turn the store left undated is kept rather than lost. */
function sinceLaunch(chat: TraycerChat, launchedAt: number): TraycerChat {
  const turns = chat.turns.filter((t) => t.timestamp === null || t.timestamp >= launchedAt);
  return { ...chat, turns, turnCount: assistantTurns({ ...chat, turns }).length };
}

/** Agents under the coordinator still working as the turn settles: it settled on a reply while they ran. */
async function activeBelow(cli: TraycerArmContext["cli"], epicId: string, senderId: string, rootId: string): Promise<string[]> {
  const agents = await cli.list(epicId, senderId);
  return collectSubtree(agents, rootId)
    .filter((a) => a.id !== rootId && a.active)
    .map((a) => a.id);
}

function lastAssistantText(chat: TraycerChat): string {
  const turns = assistantTurns(chat).filter((t) => t.text !== "");
  return turns[turns.length - 1]?.text ?? "";
}

interface Settled {
  kind: "reply" | "idle" | "timeout";
  cursor: string | null;
  /** Host timestamp of the child's send, when the chat store supplied it. */
  replyAt?: number | null;
  /** The reply's own text, so an unexpected question in it can be answered. */
  replyText?: string | null;
  /** Waiting for the subtree: when the reply came and how long the subtree held the turn open after it. */
  log?: NonNullable<TraycerPhaseDetail["settles"]>[number];
}

/**
 * Completion is the child's own send, read from its chat store. The sender's inbox
 * is only a secondary check: when the sender is a GUI agent its runtime drains the
 * inbox into a conversation turn before the CLI can see it, so `agent inbox` stays
 * empty however long it is polled. Idleness alone never counts.
 */
async function awaitSettle(
  ctx: TraycerArmContext,
  epicId: string,
  senderAgentId: string,
  childId: string,
  deadline: number,
  cursor: string | null,
  responseId: string | null,
  readChatFn: (epicId: string, chatId: string) => Promise<TraycerChat>,
  sinceMs: number,
  waitForSubtree = false,
): Promise<Settled> {
  const t = ctx.cfg.traycer;
  let idleStreak = 0;
  let polls = 0;
  let replied: { at: number | null; text: string | null } | null = null;
  let firstReplyPoll = 0;
  let firstReplyAt: number | null = null;
  const log = (kind: "reply" | "idle"): Settled["log"] =>
    waitForSubtree
      ? {
          kind,
          sentAt: new Date(sinceMs).toISOString(),
          firstReplyAt: firstReplyAt === null ? null : new Date(firstReplyAt).toISOString(),
          settledAt: nowIso(),
          polls,
          pollsHeldOpenAfterReply: firstReplyPoll === 0 ? 0 : polls - firstReplyPoll,
        }
      : undefined;

  for (;;) {
    if (Date.now() >= deadline) return { kind: "timeout", cursor };
    polls += 1;

    const chat = await readChatFn(epicId, childId);
    if (!waitForSubtree) {
      const reply = findReply(chat, senderAgentId, responseId, sinceMs);
      if (reply !== null) {
        return { kind: "reply", cursor, replyAt: reply.at, replyText: reply.message };
      }
    } else {
      // The latest reply since the send is the one whose question, if any, is answered.
      const reply = findLatestReply(chat, senderAgentId, responseId, sinceMs);
      if (reply !== null) {
        if (firstReplyPoll === 0) {
          firstReplyPoll = polls;
          firstReplyAt = reply.at;
        }
        replied = { at: reply.at, text: reply.message };
      }
    }

    const inbox = await ctx.cli.inbox(epicId, senderAgentId, cursor);
    if (inbox.nextCursor !== null) cursor = inbox.nextCursor;
    if (inbox.messages.some((m) => m.fromAgentId === childId || m.responseId !== null)) {
      if (!waitForSubtree) return { kind: "reply", cursor };
      if (firstReplyPoll === 0) firstReplyPoll = polls;
      replied ??= { at: null, text: null };
    }

    const agents = await ctx.cli.list(epicId, senderAgentId);
    const descendants = collectSubtree(agents, childId);
    const anyActive = descendants.some((a) => a.active);

    // Two consecutive inactive polls with an empty inbox, so a reply already in
    // flight is not mistaken for a stop.
    idleStreak = anyActive ? 0 : idleStreak + 1;
    if (idleStreak >= 2) {
      if (replied !== null) {
        return { kind: "reply", cursor, replyAt: replied.at, replyText: replied.text, log: log("reply") };
      }
      return { kind: "idle", cursor, log: log("idle") };
    }

    await sleep(t.pollIntervalMs);
  }
}

function collectSubtree(
  agents: { id: string; parentId: string | null; active: boolean }[],
  rootId: string,
): { id: string; parentId: string | null; active: boolean }[] {
  const out = agents.filter((a) => a.id === rootId);
  const seen = new Set(out.map((a) => a.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of agents) {
      if (seen.has(a.id)) continue;
      if (a.parentId !== null && seen.has(a.parentId)) {
        out.push(a);
        seen.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

export function dryTranscriptFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
