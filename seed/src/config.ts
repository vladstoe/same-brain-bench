export const LOAN_PERIOD_DAYS = 14;
export const MAX_OPEN_LOANS = 10;
export const OUTSTANDING_BALANCE_LIMIT_CENTS = 1000;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function requirePort(): number {
  const port = Number(requireEnv('PORT'));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}
