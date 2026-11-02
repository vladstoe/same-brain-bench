import type { Context } from 'hono';
import type { AppEnv } from './db.js';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409;

export type JsonObject = Record<string, unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: ErrorStatus,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

export async function readJson(c: Context<AppEnv>): Promise<JsonObject> {
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }
  return body as JsonObject;
}

export function idParam(c: Context<AppEnv>, name = 'id'): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return id;
}

export function stringField(body: JsonObject, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${name} is required`);
  }
  return value.trim();
}

export function idField(body: JsonObject, name: string): number {
  const value = body[name];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return value as number;
}

export function optionalIdField(body: JsonObject, name: string): number | null {
  return body[name] === undefined || body[name] === null ? null : idField(body, name);
}

export function centsField(body: JsonObject, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw badRequest(`${name} must be a positive integer number of cents`);
  }
  return value as number;
}

export function now(c: Context<AppEnv>): string {
  return c.get('clock')().toISOString();
}
