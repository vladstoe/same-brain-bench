import fs from "node:fs";
import type { BenchConfig } from "./types.ts";

/**
 * Every key routing sets for arm T: the rig proxy as the base URL, then the
 * harness environment both arms share, then the keys only arm T's override gets.
 */
export function routingEnv(cfg: BenchConfig): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://${cfg.proxy.host}:${cfg.proxy.port}`,
    ...(cfg.harnessEnv ?? {}),
    ...(cfg.traycer.overrideEnv ?? {}),
  };
}

export interface RoutingWrite {
  path: string;
  mode: "set" | "clear";
  /** The keys written, with their values, or removed. */
  keys: Record<string, string | null>;
  form: "object" | "list";
}

/**
 * Python's `json.dumps(d, indent=2)`: the same layout as `JSON.stringify` with an
 * indent, except that every character outside printable ASCII is escaped. The file
 * was written by Python before the rig wrote it, so the bytes stay as they were.
 */
function pythonJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Sets or clears arm T's routing in the host's provider overrides. The host reads
 * the file on an agent's next turn, so this is the whole switch. It touches only
 * the routing keys in the configured provider's `envOverrides`, in whichever of the
 * two shapes the host left them, and keeps everything else as it was.
 */
export function writeRouting(cfg: BenchConfig, mode: "set" | "clear", alsoClear: string[] = []): RoutingWrite {
  const file = cfg.traycer.providerOverridesPath;
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist; open the provider settings in Traycer once`);
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: Record<string, Record<string, unknown>> };
  const entry = data.providers?.[cfg.traycer.providerId];
  if (entry === undefined || entry === null || typeof entry !== "object") {
    throw new Error(`${file} has no ${cfg.traycer.providerId} provider entry`);
  }

  const env: Record<string, string> = { ...routingEnv(cfg) };
  // A key an earlier window wrote and the config has since dropped still comes out.
  if (mode === "clear") for (const key of alsoClear) if (!(key in env)) env[key] = "";
  const raw = entry["envOverrides"];
  // An absent or empty value becomes the object shape, as an empty list is falsy too.
  const empty = raw === undefined || raw === null || raw === false || raw === "" || (Array.isArray(raw) && raw.length === 0);
  let overrides: Record<string, unknown> | { key?: unknown; value?: unknown }[] = empty
    ? {}
    : (raw as Record<string, unknown> | { key?: unknown; value?: unknown }[]);
  const keys: Record<string, string | null> = {};

  for (const [key, value] of Object.entries(env)) {
    if (Array.isArray(overrides)) {
      overrides = overrides.filter((item) => item.key !== key);
      if (mode === "set") overrides.push({ key, value });
    } else {
      delete overrides[key];
      if (mode === "set") overrides[key] = value;
    }
    keys[key] = mode === "set" ? value : null;
  }
  entry["envOverrides"] = overrides;

  fs.writeFileSync(file, pythonJson(data));
  fs.appendFileSync(file, "\n");
  return { path: file, mode, keys, form: Array.isArray(overrides) ? "list" : "object" };
}
