import type { BenchConfig } from "./types.ts";

/**
 * The attempt's one epic and its sender. n = 0 is the unscored live dry run and uses
 * the smoke epic, so a rehearsal never touches an epic a scored attempt will need.
 */
export function epicFor(cfg: BenchConfig, n: number): { epicId: string; senderAgentId: string } {
  const source = n === 0 ? "traycer.smoke" : `traycer.attempts["${n}"]`;
  const entry = n === 0 ? cfg.traycer.smoke : cfg.traycer.attempts[String(n)];
  if (entry === undefined) {
    throw new Error(
      `the config has no ${source}; create an epic in the Traycer app with one sender agent in it, ` +
        "switch that agent off the claude harness, and record the epic id and the agent id there",
    );
  }
  for (const key of ["epic", "sender"] as const) {
    const value = entry[key];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${source}.${key} is not set`);
  }
  return { epicId: entry.epic as string, senderAgentId: entry.sender as string };
}
