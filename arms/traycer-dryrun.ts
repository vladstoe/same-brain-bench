import type { DryScenario } from "../src/traycer-cli.ts";
import type { AgentMessageSend, TraycerChat, TraycerTurn } from "../src/traycer-store.ts";
import { SEND_TOOL } from "../src/traycer-store.ts";

const SKILL_CALL = {
  name: "Skill",
  input: { skill: "traycer-tech-plan" },
};

function turn(
  messageId: string,
  text: string,
  opts: {
    tools?: { name: string; input: Record<string, string>; at?: number }[];
    credential?: string | null;
    sends?: AgentMessageSend[];
    at?: number;
  } = {},
): TraycerTurn {
  const tools = opts.tools ?? [];
  return {
    messageId,
    turnId: `turn-${messageId}`,
    role: "assistant",
    timestamp: opts.at ?? Date.now(),
    // Subscription auth leaves this absent; set RIG_DRYRUN_AUTH_MISMATCH=1 to
    // model a turn that fell through to an env credential instead.
    envCredentialVar:
      opts.credential !== undefined
        ? opts.credential
        : process.env["RIG_DRYRUN_AUTH_MISMATCH"] === "1"
          ? "ANTHROPIC_API_KEY"
          : null,
    hasEnvCredentialField: true,
    text,
    // The stub's calls all sit inside one turn, as a real phase's do; each gets the
    // turn's own time so the timeline has an order.
    toolCalls: tools.map((t) => ({ ...t, at: t.at ?? opts.at ?? null })),
    skillLoads: tools.filter((t) => t.name === "Skill").map((t) => t.input["skill"] ?? ""),
    sends: opts.sends ?? [],
    usage: null,
  };
}

/**
 * Cumulative, as the real adapter reports it: the second snapshot already contains
 * the first. Only the final one is ever read back.
 */
function withUsage(t: TraycerTurn, step: number): TraycerTurn {
  return {
    ...t,
    usage: {
      inputTokens: 40 * step,
      outputTokens: 600 * step,
      cacheReadInputTokens: 120_000 * step,
      cacheCreationInputTokens: 4_000 * step,
      costUsd: 1.25 * step,
      totalTokens: 640 * step,
    },
  };
}

export interface DryReplyTarget {
  senderAgentId: string | null;
  responseId: string | null;
  /** Real send times, so a reply to an earlier message is excluded by the cutoff. */
  stamps?: number[];
  phase?: "A" | "B";
  /** Phase B's reads before its first edit, when the protocol's stand-in has more than one. */
  beforeEdit?: { name: string; input: Record<string, string> }[];
}

type StubChat = Omit<TraycerChat, "turnCount" | "turnCountSource">;

/**
 * The stub has no event log, so it stands where a real chat does when compaction has
 * taken the events: the count comes from the distinct assistant turnIds, by the same
 * rule the reader applies.
 */
export function dryChat(
  chatId: string,
  scenario: DryScenario,
  worktree: string,
  dirtyAudit: boolean,
  throughTurn = Number.MAX_SAFE_INTEGER,
  replyTo: DryReplyTarget = { senderAgentId: null, responseId: null },
): TraycerChat {
  const chat = dryChatTurns(chatId, scenario, worktree, dirtyAudit, throughTurn, replyTo);
  const assistant = chat.turns.filter((t) => t.role === "assistant" || t.usage !== null);
  const ids = new Set(assistant.map((t) => t.turnId).filter((id): id is string => id !== null));
  return {
    ...chat,
    turnCount: ids.size > 0 ? ids.size : assistant.length,
    turnCountSource: ids.size > 0 ? "assistantTurnIds" : "assistantMessages",
  };
}

function dryChatTurns(
  chatId: string,
  scenario: DryScenario,
  worktree: string,
  dirtyAudit: boolean,
  /** Turns the host has actually written so far; the stub must not show the future. */
  throughTurn = Number.MAX_SAFE_INTEGER,
  /** Who the stubbed child replies to, so the send-block detector has something to match. */
  replyTo: DryReplyTarget = { senderAgentId: null, responseId: null },
): StubChat {
  // The real child answers by calling the send tool; the block it leaves behind is
  // what the rig now treats as completion.
  const replyBlock = (message: string): AgentMessageSend[] =>
    replyTo.senderAgentId === null
      ? []
      : [
          {
            receiverAgentId: replyTo.senderAgentId,
            responseId: replyTo.responseId,
            message,
            expectReply: false,
            status: "completed",
          },
        ];
  const stampFor = (i: number): number | undefined => replyTo.stamps?.[i - 1];
  const reads = [
    { name: "Read", input: { file_path: `${worktree}/src/routes/loans.ts` } },
    ...(dirtyAudit ? [{ name: "Read", input: { file_path: "/etc/hosts" } }] : []),
    ...(replyTo.phase === "B" ? (replyTo.beforeEdit ?? []) : []),
    // Phase B edits a source file, which is what the first-edit detector looks for.
    ...(replyTo.phase === "B"
      ? [{ name: "Edit", input: { file_path: `${worktree}/src/routes/loans.ts` } }]
      : []),
  ];

  if (scenario === "reply-question") {
    // The child replies on the thread, but the reply ends in a question. The rig
    // answers it and the child then finishes.
    //
    // Once the scripted reply has gone out (throughTurn >= 2) the question turn keeps
    // its skill call but loses its send block. In a real store the cutoff timestamp
    // retires it; modelling that by wall clock would make this test depend on how
    // fast the machine is.
    const QUESTION =
      "I can park reservations or scope them in. Shall I proceed with the brief as written?";
    const FINAL = "Understood, parked. Plan written and the decisions are recorded.";
    const answered = throughTurn >= 2;
    return {
      chatId,
      available: true,
      note: null,
      turns: [
        withUsage(
          turn("m1", QUESTION, {
            tools: [SKILL_CALL, { name: SEND_TOOL, input: { message: "asking" } }],
            sends: answered ? [] : replyBlock(QUESTION),
            at: stampFor(1),
          }),
          1,
        ),
        ...(answered
          ? [
              withUsage(
                turn("m2", FINAL, {
                  tools: [...reads, { name: SEND_TOOL, input: { message: "done" } }],
                  sends: replyBlock(FINAL),
                  at: stampFor(2),
                }),
                2,
              ),
            ]
          : []),
      ],
    };
  }

  if (scenario === "timeout") {
    return {
      chatId,
      available: true,
      note: null,
      turns: [withUsage(turn("m1", "Working through the routes now.", { tools: [SKILL_CALL] }), 1)],
    };
  }

  if (scenario === "no-reply") {
    return {
      chatId,
      available: true,
      note: null,
      turns: [
        withUsage(
          turn("m1", "Plan written to the epic artifacts. Nothing further from me.", {
            tools: [SKILL_CALL, ...reads],
            at: stampFor(1),
          }),
          1,
        ),
      ],
    };
  }

  if (scenario === "question" || scenario === "approval") {
    const asking =
      scenario === "approval"
        ? "The plan is written up. Shall I proceed with implementing it?"
        : "I can park reservations or scope them in. Shall I proceed with the brief as written?";
    return {
      chatId,
      available: true,
      note: null,
      turns: [
        withUsage(
          turn("m1", asking, {
            tools: [SKILL_CALL],
            at: stampFor(1),
          }),
          1,
        ),
        withUsage(
          turn("m2", "Understood. Plan written and the decisions are recorded.", {
            tools: [...reads, { name: SEND_TOOL, input: { message: "done" } }],
            sends: replyBlock("Understood. Plan written and the decisions are recorded."),
            at: stampFor(2),
          }),
          2,
        ),
      ].slice(0, throughTurn),
    };
  }

  return {
    chatId,
    available: true,
    note: null,
    turns: [
      withUsage(
        turn("m1", "Plan written and the decisions are recorded.", {
          tools: [SKILL_CALL, ...reads, { name: SEND_TOOL, input: { message: "done" } }],
          sends: replyBlock("Plan written and the decisions are recorded."),
        }),
        1,
      ),
      withUsage(
        turn("m2", "Tickets broken out under the plan.", {
          tools: [{ name: SEND_TOOL, input: { message: "done" } }],
          sends: replyBlock("Tickets broken out under the plan."),
        }),
        2,
      ),
    ].slice(0, throughTurn),
  };
}
