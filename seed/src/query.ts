import type { Context } from 'hono';
import type { AppEnv } from './db.js';
import { badRequest } from './http.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type SqlValue = string | number | null;

export class Filters {
  private readonly conditions: string[] = [];
  readonly params: SqlValue[] = [];

  add(condition: string, ...values: SqlValue[]): this {
    this.conditions.push(condition);
    this.params.push(...values);
    return this;
  }

  get where(): string {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }
}

function nonNegativeInteger(c: Context<AppEnv>, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

export function idQuery(c: Context<AppEnv>, name: string): number | undefined {
  const value = nonNegativeInteger(c, name);
  if (value === 0) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return value;
}

export function page(c: Context<AppEnv>): { sql: string; params: number[] } {
  const limit = nonNegativeInteger(c, 'limit') ?? DEFAULT_PAGE_SIZE;
  const offset = nonNegativeInteger(c, 'offset') ?? 0;
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw badRequest(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return { sql: 'LIMIT ? OFFSET ?', params: [limit, offset] };
}
