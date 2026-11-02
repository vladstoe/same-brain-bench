import { createServer } from 'node:net';
import { runBackground, sleep, type Background } from './proc.js';

export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not obtain a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export type ServerStart = { port: number; outcome: 'ready' | 'port-taken' };

export type RunningServer = {
  port: number;
  baseUrl: string;
  process: Background;
  /** Every start, in order. More than one means a probed port was taken before the server bound it. */
  starts: ServerStart[];
};

export const MAX_SERVER_STARTS = 3;

/**
 * The port is probed free and then handed to the server, and something else can take
 * it in between. Only that is retried, on a fresh port: any other exit before the
 * server is ready is the worktree's own failure and is thrown as before.
 */
export async function startServer(
  cwd: string,
  databasePath: string,
  timeoutMs = 90_000,
  pickPort: () => Promise<number> = freePort,
): Promise<RunningServer> {
  const starts: ServerStart[] = [];
  for (;;) {
    const port = await pickPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const server = runBackground('npm', ['run', 'dev'], {
      cwd,
      env: { DATABASE_PATH: databasePath, PORT: String(port) },
    });

    let portTaken = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (server.exited()) {
        if (/EADDRINUSE/.test(server.output()) && starts.length + 1 < MAX_SERVER_STARTS) {
          portTaken = true;
          break;
        }
        throw new Error(`server exited before it was ready:\n${tail(server.output())}`);
      }
      try {
        await fetch(`${baseUrl}/books`, { signal: AbortSignal.timeout(2000) });
        starts.push({ port, outcome: 'ready' });
        return { port, baseUrl, process: server, starts };
      } catch {
        await sleep(250);
      }
    }
    if (portTaken) {
      starts.push({ port, outcome: 'port-taken' });
      continue;
    }

    await server.stop();
    throw new Error(`server did not become ready within ${timeoutMs}ms:\n${tail(server.output())}`);
  }
}

export function tail(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n');
}
