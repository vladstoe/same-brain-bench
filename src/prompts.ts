import fs from "node:fs";
import path from "node:path";
import type { BenchConfig, Phase, ScriptedReplyKind } from "./types.ts";
import { rigRoot } from "./config.ts";
import { sha256 } from "./util.ts";

export function promptFiles(cfg: BenchConfig): Record<string, string> {
  const named = cfg.prompts;
  const resolve = (v: string): string => (path.isAbsolute(v) ? v : path.join(rigRoot, v));
  return {
    phaseA: resolve(named.phaseA),
    phaseB: resolve(named.phaseB),
    approvalPolicy: resolve(named.approvalPolicy),
  };
}

export function promptText(phase: Phase, cfg: BenchConfig): string {
  const files = promptFiles(cfg);
  const file = (phase === "A" ? files["phaseA"] : files["phaseB"]) as string;
  return fs.readFileSync(file, "utf8").trimEnd();
}

export function promptHashes(cfg: BenchConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(promptFiles(cfg))) {
    out[name] = sha256(fs.readFileSync(file));
  }
  return out;
}

export function approvalPolicy(cfg: BenchConfig): Record<ScriptedReplyKind, string> {
  const file = promptFiles(cfg)["approvalPolicy"] as string;
  const text = fs.readFileSync(file, "utf8");
  const replies: Partial<Record<ScriptedReplyKind, string>> = {};
  for (const line of text.split("\n")) {
    const match = /^(approval|question):\s*(.+)$/.exec(line.trim());
    if (match) replies[match[1] as ScriptedReplyKind] = (match[2] as string).trim();
  }
  if (replies.approval === undefined || replies.question === undefined) {
    throw new Error(`${file} must define an approval: and a question: line`);
  }
  return { approval: replies.approval, question: replies.question };
}

const APPROVAL_PATTERNS = [
  /\bshall i (proceed|continue|go ahead)\b/i,
  /\b(may|can) i (proceed|continue|go ahead|start)\b/i,
  /\bapprove\b/i,
  /\bapproval\b/i,
  /\bconfirm (that|whether|if|this|the)\b/i,
  /\bplease confirm\b/i,
  /\blet me know if (this|that|you)\b.*\b(ok|okay|good|fine|proceed)\b/i,
  /\bwould you like me to (proceed|continue|go ahead)\b/i,
  /\bproceed\?\s*$/i,
];

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /\bwhich (option|approach|one)\b/i,
  /\bdo you want\b/i,
  /\bwould you like\b/i,
  /\bcould you clarify\b/i,
  /\bi need to know\b/i,
];

export interface QuestionDetection {
  isQuestion: boolean;
  kind: ScriptedReplyKind;
  matched: string | null;
}

/**
 * Applied to the phase's final result text only; the span it matched is logged
 * with every scripted reply so the classification can be re-read afterwards.
 */
export function detectQuestion(finalText: string): QuestionDetection {
  const tail = finalText.trimEnd().slice(-800);
  if (tail === "") return { isQuestion: false, kind: "question", matched: null };
  for (const p of APPROVAL_PATTERNS) {
    const m = p.exec(tail);
    if (m) return { isQuestion: true, kind: "approval", matched: m[0] };
  }
  for (const p of QUESTION_PATTERNS) {
    const m = p.exec(tail);
    if (m) return { isQuestion: true, kind: "question", matched: m[0] };
  }
  return { isQuestion: false, kind: "question", matched: null };
}
