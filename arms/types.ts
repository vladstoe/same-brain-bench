import type { AttemptPaths } from "../src/paths.ts";
import type { Arm, BenchConfig, Phase, PhaseRecord, ScriptedReplyKind } from "../src/types.ts";

export interface ArmContext {
  cfg: BenchConfig;
  paths: AttemptPaths;
  arm: Arm;
  n: number;
  phase: Phase;
  prompt: string;
  policy: Record<ScriptedReplyKind, string>;
  dryRun: boolean;
  proxyBaseUrl: string;
  apiKey: string;
  /** v3's build turn: the plan turn's session, resumed rather than started afresh. */
  resumeSessionId?: string;
}

export type ArmRunner = (ctx: ArmContext) => Promise<PhaseRecord>;

/**
 * The whole environment an arm gets, built from nothing: no variable is inherited.
 * The credential is passed through the process environment and never written to
 * disk, which is what lets the per-attempt config directories stay empty of
 * anything but what the harness itself puts there.
 */
export function baseEnv(ctx: ArmContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    LANG: process.env["LANG"] ?? "en_US.UTF-8",
    TERM: "dumb",
    ANTHROPIC_BASE_URL: ctx.proxyBaseUrl,
  };
  if (ctx.cfg.auth.mode === "apiKey" && ctx.apiKey !== "") {
    env["ANTHROPIC_API_KEY"] = ctx.apiKey;
  }
  return env;
}

/** The credential for an arm, read from the environment at launch. Never logged. */
export function subscriptionCredential(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : undefined;
}
