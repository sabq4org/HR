import type { LeaveSnapshot } from './contracts.js';

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function annualLeaveDays(
  start: string,
  end: string,
  workingDays: number[],
  holidays: string[] = [],
): number {
  if (!isIsoDate(start) || !isIsoDate(end) || end < start) return 0;
  const weekdays = new Set(workingDays);
  const holidaySet = new Set(holidays);
  let count = 0;
  const cursor = new Date(`${start}T12:00:00.000Z`);
  const last = new Date(`${end}T12:00:00.000Z`);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    if (weekdays.has(cursor.getUTCDay()) && !holidaySet.has(date)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

export function snapshotMatches(
  snapshot: LeaveSnapshot,
  dates: { startDate: string; endDate: string; days: number },
): boolean {
  return (
    snapshot.startDate === dates.startDate &&
    snapshot.endDate === dates.endDate &&
    snapshot.days === dates.days
  );
}
