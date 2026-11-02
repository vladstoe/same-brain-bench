import type { Db } from './db.js';

export type JobContext = {
  db: Db;
  now: Date;
};

export type Job = (context: JobContext) => Record<string, unknown>;

export class UnknownJobError extends Error {
  constructor(readonly jobName: string) {
    super(`job ${jobName} is not registered`);
  }
}

const jobs = new Map<string, Job>();

export function register(name: string, fn: Job): void {
  if (jobs.has(name)) {
    throw new Error(`job ${name} is already registered`);
  }
  jobs.set(name, fn);
}

export function list(): string[] {
  return [...jobs.keys()].sort();
}

export function run(name: string, context: JobContext): Record<string, unknown> {
  const job = jobs.get(name);
  if (!job) {
    throw new UnknownJobError(name);
  }
  return job(context);
}
