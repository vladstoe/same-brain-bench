import type {
  AttemptRecord,
  Classification,
  EvaluatorResult,
  InfrastructureSignal,
  PhaseRecord,
} from "./types.ts";

const RATE_LIMIT = /\b(rate[_ -]?limit|rate_limit_error|429|too many requests|overloaded_error)\b/i;
const AUTH_ERROR =
  /\b(authentication_error|invalid[_ ]api[_ ]key|invalid x-api-key|401 unauthorized|permission_error|credit balance)\b/i;

/**
 * A provider rate-limit or auth error excludes an attempt only when no model turn
 * completed after it. A phase that hit one, recovered, and then ran out of time is
 * a timeout, not an exclusion.
 */
export function infrastructureSignal(
  harnessOutput: string,
  modelTurnCompletedAfterOffset: (offset: number) => boolean,
): InfrastructureSignal | null {
  const rate = RATE_LIMIT.exec(harnessOutput);
  const auth = AUTH_ERROR.exec(harnessOutput);
  const hit = rate ?? auth;
  if (hit === null) return null;
  const offset = hit.index;
  return {
    kind: rate !== null ? "rate_limit" : "auth",
    evidence: harnessOutput.slice(Math.max(0, offset - 120), offset + 200),
    modelTurnCompletedAfter: modelTurnCompletedAfterOffset(offset),
  };
}

function decisionsHeld(result: EvaluatorResult | null): boolean | null {
  if (result === null) return null;
  const decisions = result.decisions;
  if (decisions === undefined || decisions === null) return null;
  const values = Object.values(decisions);
  if (values.length === 0) return null;
  return values.every((v) => v === true);
}

function completionPassed(result: EvaluatorResult | null): boolean | null {
  if (result === null) return null;
  const completion = result.completion;
  if (completion === undefined || completion === null) return null;
  const values = Object.values(completion);
  if (values.length === 0) return null;
  const testsOk = result.existingTests;
  return values.every((v) => v === true) && testsOk !== false;
}

/** Both evaluators write `{ stage, message }`; a bare string is read too. */
function evaluatorError(result: EvaluatorResult | null): string | null {
  const err = result?.["evaluatorError"];
  if (typeof err === "string") return err !== "" ? `evaluator did not reach a verdict: ${err}` : null;
  if (typeof err !== "object" || err === null) return null;
  const { stage, message } = err as { stage?: unknown; message?: unknown };
  const lines = typeof message === "string" ? message.split("\n").map((l) => l.trim()).filter((l) => l !== "") : [];
  let first = lines[0] ?? "";
  // "server exited before it was ready:" heads captured output; the error line in it is the cause.
  if (first.endsWith(":")) {
    const cause = lines.slice(1).find((l) => /\b[A-Za-z]*Error\b|\bE[A-Z]{3,}\b/.test(l));
    if (cause !== undefined) first = `${first} ${cause}`;
  }
  return `evaluator error at ${typeof stage === "string" ? stage : "an unknown stage"}: ${first}`;
}

export function classify(
  record: AttemptRecord,
  result: EvaluatorResult | null,
): Classification {
  const phases: PhaseRecord[] = [record.phases.A, record.phases.B].filter(
    (p): p is PhaseRecord => p !== undefined,
  );

  for (const phase of phases) {
    const sig = phase.infrastructureSignal;
    if (sig !== null && sig !== undefined && !sig.modelTurnCompletedAfter) {
      return {
        outcome: "infrastructureExcluded",
        failureCause: null,
        exclusionCause: sig.kind,
        reason: `phase ${phase.phase}: provider ${sig.kind} with no model turn completed after it`,
      };
    }
  }

  // v3: a session on another Claude Code build than the pinned one, or with no build
  // recorded. Ahead of the model check because a build switch can itself put an agent
  // off the pinned model, and the build is then the cause.
  const mismatched = record.agentCheck?.mismatched ?? [];
  const offBuild = record.buildCheck?.offPin ?? [];
  if (offBuild.length > 0) {
    return {
      outcome: "infrastructureExcluded",
      failureCause: null,
      exclusionCause: "buildMismatch",
      reason:
        `${offBuild.length} agent(s) off the pinned Claude Code ${record.buildCheck?.pinnedVersion ?? "(unread)"}: ` +
        offBuild.map((m) => `${m.agentId} (${m.reasons.join("; ")})`).join(", ") +
        (mismatched.length > 0 ? `; ${mismatched.length} agent(s) also off the pinned model or effort` : ""),
    };
  }

  // v3: an agent off the pinned model or effort is an infrastructure fault, and the
  // attempt is re-run under the next n.
  if (mismatched.length > 0) {
    return {
      outcome: "infrastructureExcluded",
      failureCause: null,
      exclusionCause: "modelMismatch",
      reason:
        `${mismatched.length} agent(s) off the pinned model or effort: ` +
        mismatched.map((m) => `${m.agentId} (${m.reasons.join("; ")})`).join(", "),
    };
  }

  // No readable turns means the transcript could not be read, not that the turns
  // ran on the wrong credential. Saying authChannelMismatch there blames the
  // product for a rig fault, and on the first live attempt it did exactly that.
  for (const phase of phases) {
    const detail = phase.traycer;
    if (detail !== undefined && detail.envCredentialVars.length === 0) {
      return {
        outcome: "infrastructureExcluded",
        failureCause: null,
        exclusionCause: "transcriptUnreadable",
        reason: `phase ${phase.phase}: no readable turns in the child's chat store, so nothing about this attempt can be scored`,
      };
    }
  }

  // Arm T runs on the signed-in subscription, so turn.started must carry no
  // envCredentialVar at all: any name there means an env credential beat the
  // profile, and that turn did not run on the channel every other arm used.
  for (const phase of phases) {
    const detail = phase.traycer;
    if (detail !== undefined && !detail.authChannelOk) {
      const seen = detail.envCredentialVars.map((v) => v ?? "profile sign-in").join(", ");
      return {
        outcome: "failure",
        failureCause: "authChannelMismatch",
        exclusionCause: null,
        reason: `phase ${phase.phase}: a turn authenticated with an env credential instead of the signed-in profile (saw: ${seen || "no turns recorded"})`,
      };
    }
  }

  if (record.manifestCheckAfterA !== null && !record.manifestCheckAfterA.ok) {
    const touched = [
      ...record.manifestCheckAfterA.changed,
      ...record.manifestCheckAfterA.missing,
    ];
    return {
      outcome: "failure",
      failureCause: "planViolation",
      exclusionCause: null,
      reason: `the plan turn altered hashed seed files: ${touched.join(", ")}`,
    };
  }

  for (const phase of phases) {
    if (phase.timedOut) {
      return {
        outcome: "failure",
        failureCause: "timeout",
        exclusionCause: null,
        reason: `phase ${phase.phase} hit the hard timeout after ${phase.wallClockMs} ms`,
      };
    }
  }

  for (const phase of phases) {
    if (phase.unansweredQuestion) {
      return {
        outcome: "failure",
        failureCause: "unansweredQuestion",
        exclusionCause: null,
        reason: `phase ${phase.phase} kept asking after ${phase.scriptedReplies.length} scripted replies`,
      };
    }
  }

  const evalErr = evaluatorError(result);
  const completion = completionPassed(result);
  if (completion !== true) {
    return {
      outcome: "failure",
      failureCause: "completion",
      exclusionCause: null,
      reason:
        evalErr !== null
          ? evalErr
          : completion === null
            ? "evaluator produced no completion verdict"
            : "one or more completion checks failed",
    };
  }

  const decisions = decisionsHeld(result);
  if (decisions !== true) {
    return {
      outcome: "failure",
      failureCause: "decision",
      exclusionCause: null,
      reason:
        decisions === null
          ? "evaluator produced no decision verdict"
          : "one or more planted decisions were violated",
    };
  }

  return {
    outcome: "success",
    failureCause: null,
    exclusionCause: null,
    reason: "completion checks passed and all planted decisions held",
  };
}
