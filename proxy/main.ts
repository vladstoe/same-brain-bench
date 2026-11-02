import { createProxy, listen } from "./server.ts";
import { loadConfig } from "../src/config.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
}

const cfg = loadConfig(arg("config"));
const ledgerPath = arg("ledger");
if (ledgerPath === undefined) {
  console.error("proxy: --ledger <path> is required");
  process.exit(1);
}

const nRaw = arg("n", process.env["RIG_N"]);
const server = createProxy({
  host: arg("host", cfg.proxy.host) as string,
  port: Number(arg("port", String(cfg.proxy.port))),
  upstream: arg("upstream", process.env["RIG_UPSTREAM"] ?? cfg.proxy.upstream) as string,
  ledgerPath,
  attemptId: arg("attempt", process.env["RIG_ATTEMPT_ID"] ?? "unattributed") as string,
  arm: arg("arm", process.env["RIG_ARM"] ?? "unattributed") as string,
  n: nRaw !== undefined ? Number(nRaw) : null,
  phase: arg("phase", process.env["RIG_PHASE"] ?? "unattributed") as string,
  contextFile: arg("context-file", process.env["RIG_CONTEXT_FILE"]),
});

const host = arg("host", cfg.proxy.host) as string;
const port = Number(arg("port", String(cfg.proxy.port)));
await listen(server, host, port);
console.log(`proxy listening on http://${host}:${port} -> ${arg("upstream", cfg.proxy.upstream)}`);
console.log(`ledger ${ledgerPath}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
