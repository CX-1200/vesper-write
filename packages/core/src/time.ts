// Times are stored as UTC milliseconds and shown in Asia/Kuala_Lumpur (§5.1).

import { CONFIG } from './config.ts';

const TZ = CONFIG.timezone;

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(ms: number) {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of the display timezone from UTC at `ms`, in ms (+8 h for Malaysia). */
export function tzOffsetMs(ms: number): number {
  const p = parts(ms);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DD" of the local calendar day containing `ms`. */
export function localDayKey(ms: number): string {
  const p = parts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC ms of local 00:00 of the day containing `ms`. */
export function localDayStart(ms: number): number {
  const p = parts(ms);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  return midnightAsUtc - tzOffsetMs(ms);
}

export function localHour(ms: number): number {
  return parts(ms).hour;
}

/** "2026-10-14 09:05" in Asia/Kuala_Lumpur */
export function formatLocal(ms: number, withSeconds = false): string {
  const p = parts(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  return withSeconds ? `${base}:${pad(p.second)}` : base;
}

/** OD5: inactive hours 00:00–07:00 local time (used by R5 in v2). */
export function isInactiveHour(ms: number): boolean {
  const h = localHour(ms);
  return h >= CONFIG.inactiveHours.startHour && h < CONFIG.inactiveHours.endHour;
}
