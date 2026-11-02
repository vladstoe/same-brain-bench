import fs from "node:fs";
import path from "node:path";
import type { BenchConfig } from "./types.ts";
import { readProviderOverrides } from "./preflight.ts";
import { routingEnv, writeRouting, type RoutingWrite } from "./routing.ts";
import { exists, nowIso, readJson, sha256, writeJson } from "./util.ts";

/**
 * Equal setup for arm T, inside the routing window. `rig routing set` opens the
 * window: the user's own selection guide is backed up with its hash, the one-line bench guide
 * goes in its place, and the override gets the routing and every arm-T switch. `rig
 * routing clear` closes it: the guide is restored byte for byte and checked against
 * the hash, and every key the window wrote comes out of the override.
 *
 * The backup lives under the bench root, so a dry-run config keeps its own. A backup
 * still there means a window was never closed, by a crash or a killed chunk, and
 * nothing may open another until `clear` has restored from it.
 */

export interface WindowRecord {
  openedAt: string;
  guidePath: string;
  /** The guide as it stood before the window: what `clear` must put back. */
  originalSha256: string;
  originalBytes: number;
  benchGuideSha256: string;
  /** Every override key the window wrote, so `clear` removes them even if the config later drops one. */
  overrideKeys: string[];
}

export interface WindowPaths {
  dir: string;
  backup: string;
  record: string;
  /** The guide's hash before the latest window, kept after the window closes; preflight checks against it. */
  original: string;
  history: string;
}

export function windowPaths(cfg: BenchConfig): WindowPaths {
  const dir = path.join(cfg.benchRoot, "equal-setup");
  return {
    dir,
    backup: path.join(dir, "selection-guide.backup"),
    record: path.join(dir, "window.json"),
    original: path.join(dir, "selection-guide.original.json"),
    history: path.join(dir, "windows.jsonl"),
  };
}

export function guidePath(cfg: BenchConfig): string | null {
  return cfg.traycer.selectionGuidePath ?? null;
}

/** Every agent on the pinned harness, model and effort: the model value is the one arm T's coordinator is created with. */
export function benchGuide(cfg: BenchConfig): string {
  const model = cfg.model.armModelRef["T"] ?? cfg.model.id;
  const effort = cfg.effort ?? "high";
  return (
    `Every agent, the coordinator and every child it creates, runs on the \`${cfg.traycer.harness}\` harness ` +
    `with model \`${model}\` at \`${effort}\` reasoning effort.\n`
  );
}

/** Written whole and renamed into place, so a crash leaves the old bytes or the new ones, never half of each. */
function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.rig-tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export type WindowStep = "backup" | "override" | "guide";

export interface OpenedWindow {
  record: WindowRecord;
  routing: RoutingWrite;
}

/**
 * Opens the window. Refuses while an earlier window's backup is still present, and
 * refuses to back up a guide that is already the bench guide, which only a window
 * left open could have put there. `afterStep` lets a test stop it part way, as a
 * crash would.
 */
export function openWindow(cfg: BenchConfig, opts: { afterStep?: (step: WindowStep) => void } = {}): OpenedWindow {
  const guide = guidePath(cfg);
  if (guide === null) throw new Error("the config names no traycer.selectionGuidePath, so there is no window to open");
  const w = windowPaths(cfg);
  if (exists(w.backup) || exists(w.record)) {
    throw new Error(
      `a backup from an earlier window is still present in ${w.dir}; run \`rig routing clear\` to restore it before opening another`,
    );
  }
  if (!exists(guide)) throw new Error(`${guide} does not exist; there is no selection guide to back up`);
  const original = fs.readFileSync(guide);
  const bench = benchGuide(cfg);
  if (original.equals(Buffer.from(bench, "utf8"))) {
    throw new Error(
      `${guide} is already the bench guide and no backup exists; restore your own guide by hand before opening a window`,
    );
  }

  fs.mkdirSync(w.dir, { recursive: true });
  const record: WindowRecord = {
    openedAt: nowIso(),
    guidePath: guide,
    originalSha256: sha256(original),
    originalBytes: original.length,
    benchGuideSha256: sha256(bench),
    overrideKeys: Object.keys(routingEnv(cfg)),
  };
  // The record goes first: a window with a record and no backup is still a window
  // `set` refuses and `clear` can reason about.
  writeJson(w.record, record);
  writeAtomic(w.backup, original);
  if (sha256(fs.readFileSync(w.backup)) !== record.originalSha256) {
    throw new Error(`the backup at ${w.backup} does not hash to the guide it was copied from`);
  }
  writeJson(w.original, { sha256: record.originalSha256, bytes: record.originalBytes, recordedAt: record.openedAt });
  opts.afterStep?.("backup");

  const routing = writeRouting(cfg, "set");
  opts.afterStep?.("override");

  writeAtomic(guide, bench);
  opts.afterStep?.("guide");
  return { record, routing };
}

export interface ClosedWindow {
  /** Null when no window was open: only the override keys were cleared. */
  restored: { guidePath: string; sha256: string; verified: boolean } | null;
  routing: RoutingWrite;
}

/**
 * Closes the window, or whatever is left of one. Safe to run with no window open,
 * which is what the chunk script's trap does on every exit. The guide is restored
 * first, and the backup is kept until its hash checks out on the restored file.
 */
export function closeWindow(cfg: BenchConfig): ClosedWindow {
  const w = windowPaths(cfg);
  const record = exists(w.record) ? readJson<WindowRecord>(w.record) : null;
  let restored: ClosedWindow["restored"] = null;

  if (exists(w.backup)) {
    const guide = record?.guidePath ?? guidePath(cfg);
    if (guide === null) throw new Error(`${w.backup} exists but no guide path is known to restore it to`);
    const bytes = fs.readFileSync(w.backup);
    const expected = record?.originalSha256 ?? sha256(bytes);
    if (sha256(bytes) !== expected) {
      throw new Error(`the backup at ${w.backup} no longer hashes to ${expected}; restore ${guide} by hand`);
    }
    writeAtomic(guide, bytes);
    const verified = sha256(fs.readFileSync(guide)) === expected;
    if (!verified) throw new Error(`${guide} does not hash to ${expected} after the restore; the backup is kept`);
    restored = { guidePath: guide, sha256: expected, verified };
  }

  const routing = writeRouting(cfg, "clear", record?.overrideKeys ?? []);

  if (record !== null || exists(w.backup)) {
    fs.appendFileSync(w.history, JSON.stringify({ ...record, closedAt: nowIso(), restored }) + "\n");
    // Renamed into the history rather than deleted: the rig deletes nothing outside runs/.
    const stamp = (record?.openedAt ?? nowIso()).replace(/[:.]/g, "-");
    if (exists(w.backup)) fs.renameSync(w.backup, path.join(w.dir, `selection-guide.${stamp}.restored`));
    if (exists(w.record)) fs.renameSync(w.record, path.join(w.dir, `window.${stamp}.json`));
  }
  return { restored, routing };
}

export interface WindowState {
  open: boolean;
  guidePath: string | null;
  guideSha256: string | null;
  /** The bench guide is what the guide file holds right now. */
  guideIsBench: boolean;
  /** The hash recorded before the latest window, or null when no window has ever opened. */
  recordedOriginal: string | null;
  overrideEmpty: boolean;
  routed: boolean;
}

export function windowState(cfg: BenchConfig): WindowState {
  const w = windowPaths(cfg);
  const guide = guidePath(cfg);
  const current = guide !== null && exists(guide) ? fs.readFileSync(guide) : null;
  const overrides = readProviderOverrides(cfg);
  return {
    open: exists(w.backup) || exists(w.record),
    guidePath: guide,
    guideSha256: current === null ? null : sha256(current),
    guideIsBench: current !== null && current.equals(Buffer.from(benchGuide(cfg), "utf8")),
    recordedOriginal: exists(w.original) ? readJson<{ sha256: string }>(w.original).sha256 : null,
    overrideEmpty: overrides.empty,
    routed: overrides.routed,
  };
}

export interface SetupCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "ready";
  detail: string;
}

/**
 * Between windows every one of the user's settings is back as it was: the override holds
 * nothing and the guide hashes to what it did before the latest window. Inside one,
 * every switch is set. Either way the pins agree with the config.
 */
export function equalSetupChecks(cfg: BenchConfig): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const state = windowState(cfg);
  const ref = cfg.model.armModelRef["T"];
  const subagent = cfg.harnessEnv?.["CLAUDE_CODE_SUBAGENT_MODEL"];
  checks.push({
    name: "one pinned model value for coordinators, the bench guide and subagents",
    status:
      ref !== undefined && ref === cfg.model.armModelRef["C"] && (subagent === undefined || subagent === ref) ? "pass" : "fail",
    detail:
      `armModelRef.T=${ref ?? "(unset)"}, armModelRef.C=${cfg.model.armModelRef["C"] ?? "(unset)"}, ` +
      `CLAUDE_CODE_SUBAGENT_MODEL=${subagent ?? "(unset)"}; bench guide: ${benchGuide(cfg).trim()}`,
  });

  if (state.guidePath === null) return checks;

  if (state.open) {
    checks.push({
      name: "equal-setup window",
      status: state.routed && state.guideIsBench ? "warn" : "fail",
      detail:
        state.routed && state.guideIsBench
          ? "OPEN: every switch is set and the bench guide is in place. Fine during an arm-T attempt; " +
            "otherwise run `rig routing clear`"
          : `OPEN but incomplete (override ${state.routed ? "set" : "not set"}, guide ` +
            `${state.guideIsBench ? "is the bench guide" : "is not the bench guide"}); run \`rig routing clear\``,
    });
    return checks;
  }

  checks.push({
    name: "no attempt running: the provider override is {}",
    status: state.overrideEmpty ? "pass" : "fail",
    detail: state.overrideEmpty
      ? `${cfg.traycer.providerOverridesPath}: ${cfg.traycer.providerId}.envOverrides is empty`
      : `${cfg.traycer.providerId}.envOverrides in ${cfg.traycer.providerOverridesPath} is not empty; ` +
        "run `rig routing clear`, and remove anything else by hand",
  });
  checks.push({
    name: "no attempt running: the selection guide is the user's own",
    status:
      state.guideSha256 === null || state.guideIsBench
        ? "fail"
        : state.recordedOriginal === null
          ? "ready"
          : state.guideSha256 === state.recordedOriginal
            ? "pass"
            : "fail",
    detail:
      state.guideSha256 === null
        ? `${state.guidePath} is missing`
        : state.guideIsBench
          ? `${state.guidePath} still holds the bench guide and no backup exists`
          : state.recordedOriginal === null
            ? `sha256 ${state.guideSha256}; no window has opened yet, so the first \`rig routing set\` records it`
            : state.guideSha256 === state.recordedOriginal
              ? `sha256 ${state.guideSha256}, as recorded before the latest window`
              : `sha256 ${state.guideSha256} differs from ${state.recordedOriginal}, recorded before the latest window`,
  });
  return checks;
}
