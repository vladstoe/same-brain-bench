import fs from "node:fs";
import path from "node:path";
import type { Arm, SnapshotRecord } from "./types.ts";
import { exists, sha256File, walk } from "./util.ts";

export interface SnapshotSource {
  from: string;
  /**
   * Where this source lands under the snapshot root. For a directory it is the
   * prefix its tree is laid out beneath; for a single file it is that file's own
   * destination path, basename included — the caller already knows where the file
   * belongs, and appending a basename to it nested every file inside a directory
   * named after itself.
   */
  relTarget: string;
  origin: string;
}

/**
 * The worktree's note surfaces that phase A wrote: added, or changed from the seed's
 * copy. One the seed ships and phase A left alone is listed apart, and is neither a
 * plan nor a durable note.
 */
export function noteSurfaceSources(
  work: string,
  seedNotes: Record<string, string>,
): { sources: SnapshotSource[]; unchanged: string[] } {
  const sources: SnapshotSource[] = [];
  const unchanged: string[] = [];
  for (const note of ["CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(work, note);
    if (!exists(file)) continue;
    if (seedNotes[note] !== undefined && sha256File(file) === seedNotes[note]) {
      unchanged.push(note);
      continue;
    }
    sources.push({ from: file, relTarget: path.join("worktree", note), origin: "noteSurface" });
  }
  return { sources, unchanged };
}

/**
 * Copies every note surface into the attempt directory before phase B runs, so the
 * capture rubric is applied to what phase A actually left rather than to a tree a
 * later phase has since edited.
 */
export function takeSnapshot(
  arm: Arm,
  target: string,
  sources: SnapshotSource[],
  unchangedNoteSurfaces: string[] = [],
): SnapshotRecord {
  fs.mkdirSync(target, { recursive: true });
  const files: SnapshotRecord["files"] = [];

  for (const source of sources) {
    if (!exists(source.from)) continue;
    const stat = fs.statSync(source.from);
    const members = stat.isDirectory() ? walk(source.from) : [source.from];
    for (const file of members) {
      const relPath = stat.isDirectory()
        ? path.join(source.relTarget, path.relative(source.from, file))
        : source.relTarget;
      const dest = path.join(target, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      files.push({
        relPath,
        sha256: sha256File(file),
        bytes: fs.statSync(file).size,
        origin: source.origin,
      });
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    takenAt: new Date().toISOString(),
    arm,
    target,
    files,
    wroteNothingDurable: files.length === 0,
    unchangedNoteSurfaces: [...unchangedNoteSurfaces].sort(),
    note: files.length === 0 ? "phase A left no note surface of any kind" : null,
  };
}
