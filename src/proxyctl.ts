import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type { Arm, BenchConfig } from "./types.ts";
import type { AttemptPaths } from "./paths.ts";
import { rigRoot } from "./config.ts";

export interface ProxyHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`proxy did not open ${host}:${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

export async function startProxy(
  cfg: BenchConfig,
  paths: AttemptPaths,
  arm: Arm,
  n: number,
  phase: string,
  contextFile?: string,
): Promise<ProxyHandle> {
  fs.mkdirSync(path.dirname(paths.proxyLog), { recursive: true });
  const log = fs.openSync(paths.proxyLog, "a");
  const child = spawn(
    path.join(rigRoot, "node_modules", ".bin", "tsx"),
    [
      path.join(rigRoot, "proxy", "main.ts"),
      "--ledger",
      paths.ledger,
      "--attempt",
      paths.attemptId,
      "--arm",
      arm,
      "--n",
      String(n),
      "--phase",
      phase,
      ...(contextFile !== undefined ? ["--context-file", contextFile] : []),
    ],
    { stdio: ["ignore", log, log], detached: true, env: process.env },
  );
  child.unref();

  await waitForPort(cfg.proxy.host, cfg.proxy.port, 20_000);

  return {
    baseUrl: `http://${cfg.proxy.host}:${cfg.proxy.port}`,
    stop: async () => {
      try {
        process.kill(-(child.pid as number), "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      fs.closeSync(log);
    },
  };
}
