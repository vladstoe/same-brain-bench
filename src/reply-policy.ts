import type { BenchConfig, Phase, ScriptedReplyKind } from "./types.ts";
import { approvalPolicy } from "./prompts.ts";

/**
 * The scripted replies a phase sends, by what the detector classified. Under
 * `phaseAReply: "question"` phase A answers an approval request with the question
 * line too: an approval sent to a planner reads as leave to implement, which is
 * phase B's work. Phase B, and every config without the field, keeps both lines.
 */
export function phasePolicy(cfg: BenchConfig, phase: Phase): Record<ScriptedReplyKind, string> {
  const policy = approvalPolicy(cfg);
  if (phase === "A" && cfg.phaseAReply === "question") return { approval: policy.question, question: policy.question };
  return policy;
}
