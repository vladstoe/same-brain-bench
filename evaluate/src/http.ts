export type Probe = {
  method: string;
  path: string;
  actor: number | null;
  status: number;
  body: unknown;
  raw: string;
  ms: number;
};

export class Client {
  constructor(private readonly baseUrl: string) {}

  /** Sends no body and no content-type unless a body is given. */
  async request(
    method: string,
    path: string,
    actor: number | null,
    body?: unknown,
  ): Promise<Probe> {
    const headers: Record<string, string> = {};
    if (actor !== null) headers['x-member-id'] = String(actor);
    if (body !== undefined) headers['content-type'] = 'application/json';

    const started = Date.now();
    let status = 0;
    let raw = '';
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      status = response.status;
      raw = await response.text();
    } catch (error) {
      raw = `request failed: ${(error as Error).message}`;
    }

    let parsed: unknown = null;
    try {
      parsed = raw === '' ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }

    return { method, path, actor, status, body: parsed, raw, ms: Date.now() - started };
  }
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export function isRefused(status: number): boolean {
  return status === 401 || status === 403;
}

export function asObject(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function bodyKeys(body: unknown): string[] {
  const object = asObject(body);
  return object === null ? [] : Object.keys(object).sort();
}
