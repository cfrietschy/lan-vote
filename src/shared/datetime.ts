const GERMAN_DATE_TIME_INPUT = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:(?:\s*,\s*)|(?:\s+um\s+)|\s+)(\d{1,2}):(\d{2})$/i;

export function defaultNoticeExpiry(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

export function formatGermanDateTimeInput(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return "";
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function parseGermanDateTimeInput(value: string): Date | null {
  const match = value.trim().match(GERMAN_DATE_TIME_INPUT);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = match[3] || "";
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;

  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }

  return date;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
