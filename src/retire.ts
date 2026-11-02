import type { RetiredAgents, RetireStep } from "./types.ts";
import type { TraycerCli } from "./traycer-cli.ts";
import { nowIso } from "./util.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Where each agent sits below the coordinator: 0 for the coordinator, 1 for its
 * children, -1 for an agent whose parents never lead to it.
 */
export function depthsBelow(
  agents: { id: string; parentId: string | null }[],
  rootId: string,
): Map<string, number> {
  const parent = new Map(agents.map((a) => [a.id, a.parentId]));
  const out = new Map<string, number>();
  for (const a of agents) {
    let depth = 0;
    let at: string | null = a.id;
    const seen = new Set<string>();
    while (at !== null && at !== rootId && !seen.has(at)) {
      seen.add(at);
      at = parent.get(at) ?? null;
      depth += 1;
    }
    out.set(a.id, at === rootId ? depth : -1);
  }
  return out;
}

/** How long each agent's chain of parents is inside the epic, which orders the retirement. */
function chainLength(agents: { id: string; parentId: string | null }[], id: string): number {
  const parent = new Map(agents.map((a) => [a.id, a.parentId]));
  let n = 0;
  let at = parent.get(id) ?? null;
  const seen = new Set<string>([id]);
  while (at !== null && parent.has(at) && !seen.has(at)) {
    seen.add(at);
    n += 1;
    at = parent.get(at) ?? null;
  }
  return n;
}

/**
 * Every agent in the attempt's epic is stopped and then archived, deepest first,
 * and the sender last. The sender stops the others, the coordinator stops the
 * sender, and each archives itself. Every step is recorded, and a
 * refusal is never fatal.
 */
export async function retireEpic(
  cli: TraycerCli,
  epicId: string,
  senderAgentId: string,
  coordinatorId: string,
  opts: { retryMs: number; archiveTries?: number },
): Promise<RetiredAgents> {
  const startedAt = nowIso();
  const steps: RetireStep[] = [];
  const tries = opts.archiveTries ?? 3;

  const listed = (await cli.list(epicId, senderAgentId)).filter((a) => a.id !== senderAgentId);
  if (!listed.some((a) => a.id === coordinatorId)) listed.push({ id: coordinatorId, parentId: null } as (typeof listed)[number]);
  const depths = depthsBelow(listed, coordinatorId);
  const order = [...listed]
    .map((a) => ({ id: a.id, chain: chainLength(listed, a.id) }))
    .sort((a, b) => (b.chain !== a.chain ? b.chain - a.chain : a.id.localeCompare(b.id)))
    .map((a) => a.id);

  const step = async (targetId: string, action: "stop" | "archive", actingAs: string): Promise<void> => {
    const limit = action === "archive" ? tries : 1;
    let outcome = { ok: false, detail: null as string | null };
    let made = 0;
    while (made < limit) {
      if (made > 0) await sleep(opts.retryMs);
      made += 1;
      outcome = await cli.manage(action, epicId, actingAs, targetId, action === "stop" && targetId !== senderAgentId);
      if (outcome.ok) break;
    }
    steps.push({
      agent: targetId === senderAgentId ? "sender" : targetId === coordinatorId ? "child" : "descendant",
      agentId: targetId,
      action,
      actingAs,
      at: nowIso(),
      ok: outcome.ok,
      tries: made,
      detail: outcome.detail,
      ...(targetId === senderAgentId ? {} : { depth: depths.get(targetId) ?? -1 }),
    });
  };

  for (const id of order) await step(id, "stop", senderAgentId);
  await step(senderAgentId, "stop", coordinatorId);
  for (const id of order) await step(id, "archive", id);
  await step(senderAgentId, "archive", senderAgentId);

  return { startedAt, endedAt: nowIso(), steps, allOk: steps.every((s) => s.ok) };
}
