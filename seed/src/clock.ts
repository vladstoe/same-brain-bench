export type Clock = () => Date;

const DAY_MS = 24 * 60 * 60 * 1000;

export const systemClock: Clock = () => new Date();

export function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * DAY_MS).toISOString();
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dayRange(day: string): { start: string; end: string } {
  const start = `${day}T00:00:00.000Z`;
  return { start, end: addDays(start, 1) };
}

export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isDay(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}
