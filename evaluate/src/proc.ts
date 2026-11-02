import { spawn, type ChildProcess } from 'node:child_process';

export type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs);

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export type Background = {
  child: ChildProcess;
  output: () => string;
  exited: () => boolean;
  stop: () => Promise<void>;
};

export function runBackground(
  command: string,
  args: string[],
  options: RunOptions = {},
): Background {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let output = '';
  let exited = false;

  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on('close', () => {
    exited = true;
  });
  child.on('error', (error) => {
    output += String(error);
    exited = true;
  });

  return {
    child,
    output: () => output,
    exited: () => exited,
    stop: async () => {
      if (exited || child.pid === undefined) return;
      killTree(child.pid, 'SIGTERM');
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) {
        await sleep(50);
      }
      if (!exited) {
        killTree(child.pid, 'SIGKILL');
        await sleep(200);
      }
    },
  };
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
