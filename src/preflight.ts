import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import type { BenchConfig } from "./types.ts";
import { apiKey } from "./config.ts";
import { exists, run } from "./util.ts";
import { promptHashes } from "./prompts.ts";
import { priceTableUsable } from "./pricing.ts";
import { readChatSettings } from "./traycer-store.ts";
import { seedRepoChecks } from "./seed-clone.ts";

export interface Check {
  name: string;
  status: "pass" | "fail" | "warn" | "ready";
  detail: string;
}

export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];

export function ancestorInstructionFiles(target: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(target);
  for (;;) {
    for (const name of INSTRUCTION_FILES) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) found.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/** Environment keys the rig sets for an arm itself, which a shared harness environment must not carry. */
export const RIG_OWNED_ENV = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
]);

/** The shared harness keys the rig already sets for an arm. */
export function reservedHarnessKeys(cfg: BenchConfig): string[] {
  return Object.keys(cfg.harnessEnv ?? {}).filter(
    (k) => RIG_OWNED_ENV.has(k) || k === cfg.auth.claudeOauthTokenEnvVar,
  );
}

export interface OverrideState {
  path: string;
  present: boolean;
  baseUrl: string | null;
  baseUrlMatches: boolean;
  apiKeySet: boolean;
  keys: string[];
  /** Each key of the config's shared harness environment, as the file has it. */
  harnessEnv: { key: string; expected: string; actual: string | null; matches: boolean }[];
  /** The base URL and every harness key are what the config asks for. */
  routed: boolean;
  /** The provider's `envOverrides` holds nothing at all, which is how it is left between windows. */
  empty: boolean;
  note: string | null;
}

/**
 * Read-only. The file is host-owned; the rig writes it only through `rig routing`,
 * which changes nothing but the routing keys.
 */
export function readProviderOverrides(cfg: BenchConfig): OverrideState {
  const file = cfg.traycer.providerOverridesPath;
  const expected = `http://${cfg.proxy.host}:${cfg.proxy.port}`;
  const extras = Object.entries({ ...(cfg.harnessEnv ?? {}), ...(cfg.traycer.overrideEnv ?? {}) });
  const blank: OverrideState = {
    path: file,
    present: false,
    baseUrl: null,
    baseUrlMatches: false,
    apiKeySet: false,
    keys: [],
    harnessEnv: extras.map(([key, value]) => ({ key, expected: value, actual: null, matches: false })),
    routed: false,
    empty: false,
    note: null,
  };
  if (!exists(file)) return { ...blank, note: "file not found" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...blank, note: "file is not valid JSON" };
  }
  const providers = (parsed as { providers?: Record<string, unknown> }).providers;
  const entry = providers?.[cfg.traycer.providerId] as { envOverrides?: unknown } | undefined;
  if (entry === undefined) return { ...blank, note: `no ${cfg.traycer.providerId} entry` };

  const raw = entry.envOverrides;
  const map: Record<string, string | null> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const e = item as { key?: unknown; value?: unknown };
      if (typeof e.key === "string") map[e.key] = typeof e.value === "string" ? e.value : null;
    }
  } else if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      map[k] = typeof v === "string" ? v : null;
    }
  }

  const baseUrl = map["ANTHROPIC_BASE_URL"] ?? null;
  const key = map["ANTHROPIC_API_KEY"];
  const baseUrlMatches = baseUrl !== null && baseUrl.replace(/\/$/, "") === expected;
  const harnessEnv = extras.map(([k, value]) => {
    const actual = map[k] ?? null;
    return { key: k, expected: value, actual, matches: actual === value };
  });
  return {
    path: file,
    present: Object.keys(map).length > 0,
    baseUrl,
    baseUrlMatches,
    apiKeySet: typeof key === "string" && key !== "",
    keys: Object.keys(map).sort(),
    harnessEnv,
    routed: baseUrlMatches && harnessEnv.every((e) => e.matches),
    empty:
      raw === undefined ||
      raw === null ||
      (Array.isArray(raw) ? raw.length === 0 : typeof raw === "object" && Object.keys(raw as object).length === 0),
    note: null,
  };
}

/**
 * The version Traycer itself will launch, from the provider pack's own pointer,
 * resolved next to whatever binary is pinned.
 */
export function readCurrentProviderVersion(pinnedBinary: string): string | null {
  // <...>/darwin-arm64/<version>/claude -> <...>/darwin-arm64/current.json
  const file = path.join(path.dirname(path.dirname(pinnedBinary)), "current.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface PinnedBuild {
  binary: string;
  res: Awaited<ReturnType<typeof run>>;
  /** The first word of the binary's own `--version`; null when it did not run or printed nothing. */
  pinnedVersion: string | null;
  /** Traycer's current pack, from the current.json beside the pinned binary's pack. */
  current: string | null;
  /** Both read, and they differ. */
  drifted: boolean;
}

export async function readPinnedBuild(binary: string): Promise<PinnedBuild> {
  const res = await run(binary, ["--version"], { timeoutMs: 60_000 });
  // Traycer follows current.json, so a pin that drifts from it silently splits the
  // two arms across builds — and builds differ in which model ids they accept.
  const current = readCurrentProviderVersion(binary);
  const word = (res.stdout.trim().split(" ")[0] ?? "").trim();
  const pinnedVersion = res.code === 0 && word !== "" ? word : null;
  return { binary, res, pinnedVersion, current, drifted: pinnedVersion !== null && current !== null && current !== pinnedVersion };
}

/**
 * v3: why an attempt must not start on this build, or null when it may. Stricter than
 * preflight, which passes when current.json is unreadable: here either side unread refuses.
 */
export function pinnedBuildProblem(build: PinnedBuild | null): string | null {
  if (build === null) return "claudeBinary is not set, so arm C's build cannot be read or compared with Traycer's";
  if (build.pinnedVersion === null) {
    return `the pinned binary's version cannot be read: \`${build.binary} --version\` ` +
      `${build.res.code !== 0 ? `exited ${build.res.code}${build.res.stderr.trim() !== "" ? `: ${build.res.stderr.trim()}` : ""}` : "printed nothing"}`;
  }
  if (build.current === null) {
    return `Traycer's current pack version cannot be read from ${path.join(path.dirname(path.dirname(build.binary)), "current.json")}`;
  }
  if (build.drifted) {
    return `claudeBinary is ${build.pinnedVersion} but Traycer now runs ${build.current} (current.json); ` +
      `arm C would be on ${build.pinnedVersion} and arm T on ${build.current}. Repin claudeBinary to the ${build.current} path`;
  }
  return null;
}

export function canaryPaths(cfg: BenchConfig): { realClaudeMd: string; ancestorMd: string } {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
  return {
    realClaudeMd: path.join(configDir, "CLAUDE.md"),
    ancestorMd: path.join(path.dirname(path.resolve(cfg.benchRoot)), "CLAUDE.md"),
  };
}

/**
 * Two canaries, two tokens, two different claims — sharing one token made an echo
 * unattributable.
 *
 * REAL_CONFIG proves isolation: Claude Code must not read the user's own config
 * directory when CLAUDE_CONFIG_DIR points elsewhere. A paid probe asserts it is
 * never echoed.
 *
 * ANCESTOR proves the guard, not isolation. Claude Code legitimately reads
 * CLAUDE.md from every ancestor of its working directory, so a canary above the
 * bench root WILL be echoed and asserting otherwise tests nothing. What matters is
 * that `rig new` refuses to create an attempt underneath one, which needs no model
 * call at all.
 */
export const CANARY_TOKENS = {
  realConfig: "CANARY-7QW4ZK-REALCONFIG",
  ancestor: "CANARY-7QW4ZK-ANCESTOR",
} as const;

/** Kept for the probe's echo assertion, which only ever concerns the real config. */
export const CANARY_TOKEN = CANARY_TOKENS.realConfig;

const CLAUDE_CREDENTIAL_HINT = (cfg: BenchConfig): string =>
  `An isolated CLAUDE_CONFIG_DIR starts signed out; mint one with ` +
  `\`${cfg.claudeBinary ?? "claude"} setup-token\` and export it.`;

/**
 * The credential an arm cannot run without, or null when it has one. Arm T's
 * credential is the provider override, checked separately.
 */
export function missingArmCredential(cfg: BenchConfig, arm: string): string | null {
  if (cfg.auth.mode !== "subscription" || arm !== "C") return null;
  const varName = cfg.auth.claudeOauthTokenEnvVar;
  const value = process.env[varName];
  return value !== undefined && value !== "" ? null : varName;
}

export async function freeChecks(cfg: BenchConfig): Promise<Check[]> {
  const checks: Check[] = [];

  const ancestors = ancestorInstructionFiles(cfg.benchRoot);
  checks.push({
    name: "bench root ancestors carry no CLAUDE.md or AGENTS.md",
    status: ancestors.length === 0 ? "pass" : "fail",
    detail: ancestors.length === 0 ? cfg.benchRoot : `found: ${ancestors.join(", ")}`,
  });

  const pinned = cfg.claudeBinary;
  if (pinned !== undefined) {
    const { res, current, pinnedVersion, drifted } = await readPinnedBuild(pinned);
    checks.push({
      name: "pinned claude binary runs (arms C and T share one build)",
      status: res.code !== 0 ? "fail" : drifted ? "fail" : "pass",
      detail:
        res.code !== 0
          ? `${pinned}: ${res.stderr.trim()}`
          : drifted
            ? `claudeBinary is ${pinnedVersion} but Traycer now runs ${current} (current.json). ` +
              `Arm C would be on ${pinnedVersion} and arm T on ${current}; repin claudeBinary to the ${current} path.`
            : `${res.stdout.trim()} at ${pinned}${current === null ? "" : `, matches current.json (${current})`}`,
    });
  }

  for (const [bin, args] of [
    ["claude", ["--version"]],
    ["node", ["--version"]],
    ["npm", ["--version"]],
    ["git", ["--version"]],
  ] as [string, string[]][]) {
    const res = await run(bin, args, { timeoutMs: 30_000 });
    checks.push({
      name: `${bin} resolves`,
      status: res.code === 0 ? "pass" : "fail",
      detail: res.code === 0 ? res.stdout.trim().split("\n")[0] ?? "" : res.stderr.trim(),
    });
  }

  const tag = await run("git", ["-C", cfg.seedRepoPath, "rev-parse", `${cfg.seedTag}^{commit}`]);
  checks.push({
    name: `seed tag ${cfg.seedTag} exists`,
    status: tag.code === 0 ? "pass" : "fail",
    detail: tag.code === 0 ? tag.stdout.trim() : tag.stderr.trim(),
  });
  checks.push(...(await seedRepoChecks(cfg)));

  const key = apiKey(cfg);
  const keySet = key !== undefined && key !== "";
  const subscription = cfg.auth.mode === "subscription";
  checks.push({
    name: "authentication mode",
    status: subscription && keySet && !cfg.auth.allowApiKey ? "fail" : "pass",
    detail: !subscription
      ? `API-key mode via ${cfg.apiKeyEnvVar}`
      : keySet
        ? cfg.auth.allowApiKey
          ? `subscription mode, but ${cfg.apiKeyEnvVar} is set and auth.allowApiKey is true`
          : `subscription mode, but ${cfg.apiKeyEnvVar} IS SET — unset it, or set auth.allowApiKey: true`
        : `subscription mode (${cfg.apiKeyEnvVar} unset, as intended)`,
  });

  if (subscription) {
    // A missing credential is a warn, not a fail: it stops only that arm, and a
    // fail here would abort the whole preflight before the probes could skip it.
    // The refusal is enforced where it bites, in `rig new` and `rig phase-*`.
    const varName = cfg.auth.claudeOauthTokenEnvVar;
    const value = process.env[varName];
    checks.push({
      name: `arm C credential ${varName} is set`,
      status: value !== undefined && value !== "" ? "pass" : "warn",
      detail:
        value !== undefined && value !== ""
          ? "present (value never read or logged)"
          : `unset — arm C will be skipped by --probes and \`rig\` refuses to run arm C ` +
            `phases until it is set. ${CLAUDE_CREDENTIAL_HINT(cfg)}`,
    });
  }

  const hashes = promptHashes(cfg);
  checks.push({
    name: "prompt files readable",
    status: "pass",
    detail: Object.entries(hashes)
      .map(([k, v]) => `${k}=${v.slice(0, 12)}`)
      .join(" "),
  });

  if (cfg.harnessEnv !== undefined) {
    // Keys the rig sets itself would be overridden in arm C and fight the routing in arm T.
    const reserved = reservedHarnessKeys(cfg);
    checks.push({
      name: "harness environment shared by arms C and T",
      status: reserved.length === 0 ? "pass" : "fail",
      detail:
        reserved.length === 0
          ? Object.entries(cfg.harnessEnv).map(([k, v]) => `${k}=${v}`).join(", ") +
            ": arm C's spawn environment, arm T's provider override"
          : `${reserved.join(", ")} ${reserved.length === 1 ? "is" : "are"} set by the rig itself; remove from harnessEnv`,
    });
  }

  if (cfg.phaseAReply !== undefined) {
    const known = cfg.phaseAReply === "question";
    checks.push({
      name: "phase A scripted reply",
      status: known ? "pass" : "fail",
      detail: known
        ? `phaseAReply=question: phase A answers an approval request with the question line; phase B keeps the approval line`
        : `phaseAReply=${String(cfg.phaseAReply)} is not "question"`,
    });
  }

  if (cfg.effort !== undefined) {
    const known = ["low", "medium", "high", "xhigh", "max"].includes(cfg.effort);
    checks.push({
      name: "reasoning effort pinned, the same for arms C and T",
      status: known ? "pass" : "fail",
      detail: known
        ? `${cfg.effort}: claude --effort for arm C, traycer agent create --reasoning-effort for arm T`
        : `${cfg.effort} is not one of low, medium, high, xhigh, max`,
    });
  }

  const prices = priceTableUsable(cfg.prices);
  checks.push({
    name: "frozen price table is usable",
    status: prices.usable ? "pass" : "warn",
    detail: prices.reason ?? `verified ${cfg.prices.verifiedOn}`,
  });

  checks.push({
    name: "pinned model id confirmed against the API",
    status: cfg.model.verified ? "pass" : "warn",
    detail: cfg.model.verified ? cfg.model.id : `${cfg.model.id} (provisional)`,
  });

  const free = await portFree(cfg.proxy.host, cfg.proxy.port);
  checks.push({
    name: `proxy port ${cfg.proxy.port} is free`,
    status: free ? "pass" : "warn",
    detail: free ? "free" : "something is already listening",
  });

  const overrides = readProviderOverrides(cfg);
  const keyInOverride = overrides.apiKeySet && cfg.auth.mode === "subscription" && !cfg.auth.allowApiKey;
  // Routed with an extra key missing is a half-set state no run should start from.
  const extrasOff = overrides.harnessEnv.filter((e) => !e.matches);
  const halfRouted = overrides.baseUrlMatches && extrasOff.length > 0;
  checks.push({
    name: "arm T routing: provider env overrides point at the rig proxy",
    status: keyInOverride || halfRouted ? "fail" : overrides.routed ? "pass" : "ready",
    detail: keyInOverride
      ? `ANTHROPIC_API_KEY is set in the provider override; in subscription mode it must be removed, ` +
        `or every Traycer turn runs on a key instead of the signed-in profile`
      : halfRouted
        ? `ANTHROPIC_BASE_URL is set but ${extrasOff.map((e) => `${e.key}=${e.actual ?? "(unset)"}`).join(", ")} ` +
          `differs from the config; run \`rig routing set\``
        : overrides.routed
          ? `ANTHROPIC_BASE_URL=${overrides.baseUrl}` +
            `${overrides.harnessEnv.map((e) => `, ${e.key}=${e.actual}`).join("")}` +
            `${cfg.auth.mode === "subscription" ? ", no API key (correct)" : ""}`
          : `${overrides.note ?? `keys: ${overrides.keys.join(", ") || "none"}`} — \`rig routing set\` writes ` +
            `ANTHROPIC_BASE_URL${overrides.harnessEnv.map((e) => ` and ${e.key}`).join("")} for ` +
            `${cfg.traycer.providerId}; arm T refuses to start without it`,
  });

  // A `claude` sender is routed by the same provider override as arm T, so its
  // wake reaches the proxy and contaminates the attempt's ledger. It also drains
  // its own inbox into a GUI turn, which is what broke the completion signal.
  const senders: { label: string; epicId: string; senderId: string }[] = [];
  for (const [n, entry] of Object.entries(cfg.traycer.attempts)) {
    if (typeof entry.epic === "string" && typeof entry.sender === "string") {
      senders.push({ label: `attempt ${n}`, epicId: entry.epic, senderId: entry.sender });
    }
  }
  const smoke = cfg.traycer.smoke;
  if (typeof smoke.epic === "string" && typeof smoke.sender === "string") {
    senders.push({ label: "smoke", epicId: smoke.epic, senderId: smoke.sender });
  }

  if (senders.length === 0) {
    checks.push({
      name: "arm T senders are not on the claude harness",
      status: "ready",
      detail: "no sender configured yet in traycer.attempts / traycer.smoke",
    });
  } else {
    // Underscore-prefixed so the report walk skips it, like the other scratch.
    const scratch = path.join(cfg.benchRoot, "runs", "_preflight");
    const offenders: string[] = [];
    const unknown: string[] = [];
    for (const s2 of senders) {
      const settings = await readChatSettings(cfg, s2.epicId, s2.senderId, scratch);
      if (settings === null || settings.harnessId === null) {
        unknown.push(`${s2.label} (${s2.senderId.slice(0, 8)})`);
      } else if (settings.harnessId === cfg.traycer.harness) {
        offenders.push(`${s2.label} (${s2.senderId.slice(0, 8)}) = ${settings.harnessId}`);
      }
    }
    checks.push({
      name: "arm T senders are not on the claude harness",
      status: offenders.length > 0 ? "fail" : unknown.length > 0 ? "warn" : "pass",
      detail:
        offenders.length > 0
          ? `${offenders.join("; ")} — switch each with \`traycer agent configure --agent-id <id> ` +
            `--harness codex --model <codex model> --profile ambient\``
          : unknown.length > 0
            ? `harness unreadable for: ${unknown.join(", ")}`
            : `${senders.length} sender(s), none on ${cfg.traycer.harness}`,
    });
  }

  const traycerCli = await run(cfg.traycer.cliPath, ["--version"], { timeoutMs: 30_000 });
  checks.push({
    name: "traycer CLI resolves",
    status: traycerCli.code === 0 ? "pass" : "fail",
    detail: traycerCli.code === 0 ? traycerCli.stdout.trim() : traycerCli.stderr.trim(),
  });

  const canaries = canaryPaths(cfg);

  // The ancestor guard is verifiable for free: plant the file, ask the same
  // function `rig new` asks, and see it refuse.
  const ancestorPlanted =
    exists(canaries.ancestorMd) &&
    fs.readFileSync(canaries.ancestorMd, "utf8").includes(CANARY_TOKENS.ancestor);
  if (ancestorPlanted) {
    const caught = ancestorInstructionFiles(cfg.benchRoot).includes(canaries.ancestorMd);
    checks.push({
      name: "ancestor canary makes `rig new` refuse",
      status: caught ? "pass" : "fail",
      detail: caught
        ? `${canaries.ancestorMd} is seen by the ancestor check, so no attempt can be created under it — remove it by hand`
        : `${canaries.ancestorMd} exists but the ancestor check does not see it`,
    });
  } else {
    checks.push({
      name: "ancestor canary makes `rig new` refuse",
      status: "ready",
      detail: `not planted; \`rig preflight --canaries\` writes ${canaries.ancestorMd} and re-checks, no model call`,
    });
  }

  const realPlanted =
    exists(canaries.realClaudeMd) &&
    fs.readFileSync(canaries.realClaudeMd, "utf8").includes(CANARY_TOKENS.realConfig);
  checks.push({
    name: "real-config canary planted for the probe",
    status: realPlanted ? "pass" : "ready",
    detail: realPlanted
      ? `${canaries.realClaudeMd} — remove it by hand after the probe`
      : `not planted; \`rig preflight --probes\` writes ${canaries.realClaudeMd}`,
  });

  return checks;
}

export type CanaryKind = "realConfig" | "ancestor";

/**
 * Plants one canary. Refuses to overwrite a file that is not already this canary,
 * and never deletes: the caller prints the `rm` for a human.
 */
export function plantCanary(
  cfg: BenchConfig,
  kind: CanaryKind,
): { written: string | null; refused: string | null } {
  const paths = canaryPaths(cfg);
  const target = kind === "realConfig" ? paths.realClaudeMd : paths.ancestorMd;
  const token = CANARY_TOKENS[kind];
  if (exists(target) && !fs.readFileSync(target, "utf8").includes(token)) {
    return { written: null, refused: target };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `# canary\n\nIf you can read this file, say ${token} in your reply.\n`);
  return { written: target, refused: null };
}
