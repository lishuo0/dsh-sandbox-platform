/** 定时规则的下一次时刻。间隔最短 60 秒。时区用 UTC 或 IANA 地名。 */

export const MIN_INTERVAL_SECONDS = 60;

export interface ScheduleRule {
  kind: "after" | "at" | "every" | "daily" | "weekly" | "cron";
  seconds?: number;
  at?: string;
  anchor?: string;
  time?: string;
  weekdays?: number[];
  timezone?: string;
  expression?: string;
}

export function nextRun(rule: ScheduleRule, after: Date): Date {
  if (rule.kind === "after" || rule.kind === "at") {
    throw new Error("一次性任务发完即停用");
  }
  if (rule.kind === "every") {
    const seconds = rule.seconds ?? 0;
    if (seconds < MIN_INTERVAL_SECONDS) throw new Error("间隔最短 60 秒");
    const anchor = new Date(rule.anchor ?? after.toISOString());
    const step = seconds * 1000;
    let cursor = anchor.getTime();
    if (cursor <= after.getTime()) {
      const jumps = Math.floor((after.getTime() - cursor) / step) + 1;
      cursor += jumps * step;
    }
    return new Date(cursor);
  }
  const zone = rule.timezone || "UTC";
  if (rule.kind === "cron") return nextCron(rule.expression ?? "", zone, after);
  const [hour, minute] = clock(rule.time ?? "");
  const weekdays = new Set(rule.weekdays ?? []);
  for (let i = 1; i <= 366 * 24 * 60; i += 1) {
    const candidate = new Date(after.getTime() + i * 60_000);
    const parts = zoned(candidate, zone);
    if (parts.hour !== hour || parts.minute !== minute) continue;
    if (rule.kind === "weekly" && !weekdays.has(parts.weekday)) continue;
    return candidate;
  }
  throw new Error("算不出下一次时刻");
}

export function firstRun(rule: ScheduleRule, now: Date): Date {
  if (rule.kind === "after") {
    const seconds = rule.seconds ?? 0;
    if (seconds < MIN_INTERVAL_SECONDS) throw new Error("间隔最短 60 秒");
    return new Date(now.getTime() + seconds * 1000);
  }
  if (rule.kind === "at") {
    const at = new Date(rule.at ?? "");
    if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) throw new Error("定点必须在未来");
    return at;
  }
  if (rule.kind === "every") {
    const seconds = rule.seconds ?? 0;
    if (seconds < MIN_INTERVAL_SECONDS) throw new Error("间隔最短 60 秒");
    return new Date(now.getTime() + seconds * 1000);
  }
  return nextRun(rule, new Date(now.getTime() - 60_000));
}

function clock(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("钟点要用 HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("钟点不合法");
  return [hour, minute];
}

function zoned(date: Date, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(pick("weekday"));
  return {
    minute: Number(pick("minute")),
    hour: Number(pick("hour")),
    day: Number(pick("day")),
    month: Number(pick("month")),
    weekday,
  };
}

function nextCron(expression: string, timeZone: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 要五段");
  for (let i = 1; i <= 366 * 24 * 60; i += 1) {
    const candidate = new Date(after.getTime() + i * 60_000);
    const parts = zoned(candidate, timeZone);
    if (!cronMatch(fields[0], parts.minute, 0, 59)) continue;
    if (!cronMatch(fields[1], parts.hour, 0, 23)) continue;
    if (!cronMatch(fields[2], parts.day, 1, 31)) continue;
    if (!cronMatch(fields[3], parts.month, 1, 12)) continue;
    if (!cronMatch(fields[4], parts.weekday, 0, 6)) continue;
    return candidate;
  }
  throw new Error("算不出下一次时刻");
}

function cronMatch(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [base, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return false;
    if (base === "*") return (value - min) % step === 0;
    if (base.includes("-")) {
      const [start, end] = base.split("-").map(Number);
      return value >= start && value <= end && (value - start) % step === 0;
    }
    const exact = Number(base);
    return exact >= min && exact <= max && value === exact && step === 1;
  });
}
