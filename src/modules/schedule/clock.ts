/**
 * 定时规则的下一次时刻。
 *
 * 规则由脑写入 `dsh_schedule_tasks`：kind 在单独的列里，rule JSON 只放参数，
 * 键名与脑 `packages/dsh-schedule-tasks/src/time.ts` 一致（everySeconds、
 * timeZone、weekdays 用 ISO 1-7）。这里只算重复规则的下一次时刻；一次性任务
 * 发完即停用，不调用本模块。改规则语义时两边一起改。
 */

export const MIN_INTERVAL_SECONDS = 60;

export interface ScheduleRule {
  everySeconds?: number;
  /** 间隔类的锚点，创建或修改规则时的 ISO 时刻。 */
  anchor?: string;
  /** HH:mm:ss，可带 1-3 位毫秒。 */
  time?: string;
  timeZone?: string;
  /** ISO 星期：周一 1，周日 7。 */
  weekdays?: number[];
  expression?: string;
}

export function nextRun(kind: string, rule: ScheduleRule, after: Date): Date {
  switch (kind) {
    case "after":
    case "at":
      throw new Error("一次性任务发完即停用");
    case "every":
      return nextEvery(rule, after);
    case "daily":
    case "weekly":
      return nextClock(rule, after);
    case "cron":
      return nextCron(rule, after);
    default:
      throw new Error(`未知的定时规则：${kind}`);
  }
}

function nextEvery(rule: ScheduleRule, after: Date): Date {
  const seconds = Number(rule.everySeconds);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) throw new Error("间隔最短 60 秒");
  const anchor = new Date(rule.anchor ?? after.toISOString());
  if (Number.isNaN(anchor.getTime())) throw new Error("间隔的锚点不合法");
  const step = seconds * 1000;
  const anchorMs = anchor.getTime();
  const afterMs = after.getTime();
  if (afterMs < anchorMs) return new Date(anchorMs + step);
  const n = Math.floor((afterMs - anchorMs) / step);
  return new Date(anchorMs + (n + 1) * step);
}

function nextClock(rule: ScheduleRule, after: Date): Date {
  const parts = parseClock(rule.time ?? "");
  const zone = rule.timeZone || "UTC";
  const weekdays = rule.weekdays === undefined ? null : new Set(rule.weekdays);
  const local = zoneParts(after, zone);
  let cursor = { year: local.year, month: local.month, day: local.day };
  for (let i = 0; i < 370; i += 1) {
    const noon = zonedTime(cursor.year, cursor.month, cursor.day, 12, 0, 0, 0, zone);
    const weekday = noon === undefined ? undefined : isoWeekday(noon, zone);
    if (weekday !== undefined && (weekdays === null || weekdays.has(weekday))) {
      const candidate = zonedTime(cursor.year, cursor.month, cursor.day, parts.hour, parts.minute, parts.second, parts.millisecond, zone);
      if (candidate !== undefined && candidate.getTime() > after.getTime()) return candidate;
    }
    cursor = addLocalDays(cursor.year, cursor.month, cursor.day, 1, zone);
  }
  throw new Error("算不出下一次时刻");
}

function nextCron(rule: ScheduleRule, after: Date): Date {
  const spec = parseCron(rule.expression ?? "");
  const zone = rule.timeZone || "UTC";
  const local = zoneParts(after, zone);
  let cursor = { year: local.year, month: local.month, day: local.day };
  const hours = fieldValues(spec.hour);
  const minutes = fieldValues(spec.minute);
  for (let i = 0; i < 370; i += 1) {
    if (spec.month.bits[cursor.month]) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = zonedTime(cursor.year, cursor.month, cursor.day, hour, minute, 0, 0, zone);
          if (candidate === undefined || candidate.getTime() <= after.getTime()) continue;
          const parts = zoneParts(candidate, zone);
          if (!cronDayMatches(spec, parts.day, CRON_WEEKDAY[parts.weekday] ?? -1)) continue;
          return candidate;
        }
      }
    }
    cursor = addLocalDays(cursor.year, cursor.month, cursor.day, 1, zone);
  }
  throw new Error("算不出下一次时刻");
}

interface ClockParts {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function parseClock(value: string): ClockParts {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(value);
  if (match === null) throw new Error("钟点要用 HH:mm:ss");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  const millisecond = match[4] === undefined ? 0 : Number(match[4].padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) throw new Error("钟点不合法");
  return { hour, minute, second, millisecond };
}

const ISO_WEEKDAY: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const CRON_WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const MONTH_NAMES: readonly (readonly [string, string])[] = [
  ["january", "1"], ["february", "2"], ["march", "3"], ["april", "4"],
  ["may", "5"], ["june", "6"], ["july", "7"], ["august", "8"],
  ["september", "9"], ["october", "10"], ["november", "11"], ["december", "12"],
  ["jan", "1"], ["feb", "2"], ["mar", "3"], ["apr", "4"],
  ["jun", "6"], ["jul", "7"], ["aug", "8"], ["sep", "9"], ["oct", "10"], ["nov", "11"], ["dec", "12"],
];
const DOW_NAMES: readonly (readonly [string, string])[] = [
  ["sunday", "0"], ["monday", "1"], ["tuesday", "2"], ["wednesday", "3"],
  ["thursday", "4"], ["friday", "5"], ["saturday", "6"],
  ["sun", "0"], ["mon", "1"], ["tue", "2"], ["wed", "3"], ["thu", "4"], ["fri", "5"], ["sat", "6"],
];

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

interface CronField {
  min: number;
  max: number;
  bits: boolean[];
}

interface CronSpec {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    zoneFormatters.set(timeZone, fmt);
  }
  return fmt;
}

function zoneParts(date: Date, timeZone: string): ZoneParts {
  const bag: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) bag[part.type] = part.value;
  let hour = Number(bag["hour"]);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag["year"]),
    month: Number(bag["month"]),
    day: Number(bag["day"]),
    hour,
    minute: Number(bag["minute"]),
    second: Number(bag["second"]),
    weekday: bag["weekday"] ?? "",
  };
}

/** 某个本地钟点对应的时刻；夏令时跳过的钟点返回 undefined，重复的取较早一次。 */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number, timeZone: string): Date | undefined {
  if (!realDate(year, month, day)) return undefined;
  const want = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let guess = want;
  for (let i = 0; i < 4; i += 1) {
    const got = zoneParts(new Date(guess), timeZone);
    const asUTC = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second, millisecond);
    const delta = want - asUTC;
    if (delta === 0) break;
    guess += delta;
  }
  const got = zoneParts(new Date(guess), timeZone);
  if (got.year !== year || got.month !== month || got.day !== day || got.hour !== hour || got.minute !== minute || got.second !== second) {
    return undefined;
  }
  let best = guess;
  for (const back of [3_600_000, 7_200_000]) {
    const candidate = guess - back;
    const parts = zoneParts(new Date(candidate), timeZone);
    if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute && parts.second === second && candidate < best) {
      best = candidate;
    }
  }
  return new Date(best);
}

function isoWeekday(date: Date, timeZone: string): number {
  return ISO_WEEKDAY[zoneParts(date, timeZone).weekday] ?? 0;
}

function addLocalDays(year: number, month: number, day: number, delta: number, timeZone: string): { year: number; month: number; day: number } {
  const noon = zonedTime(year, month, day, 12, 0, 0, 0, timeZone);
  const base = noon !== undefined ? noon.getTime() : Date.UTC(year, month - 1, day, 12);
  const parts = zoneParts(new Date(base + delta * 86_400_000), timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 要五段");
  return {
    minute: parseCronField(fields[0] ?? "", 0, 59, false),
    hour: parseCronField(fields[1] ?? "", 0, 23, false),
    dom: parseCronField(fields[2] ?? "", 1, 31, false),
    month: parseCronField(replaceNames(fields[3] ?? "", MONTH_NAMES), 1, 12, false),
    dow: parseCronField(replaceNames(fields[4] ?? "", DOW_NAMES), 0, 6, true),
  };
}

function parseCronField(raw: string, min: number, max: number, dow: boolean): CronField {
  const field: CronField = { min, max, bits: Array.from({ length: max + 1 }, () => false) };
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (piece === "") throw new Error("cron 不合法");
    let step = 1;
    let body = piece;
    const slash = piece.indexOf("/");
    if (slash >= 0) {
      body = piece.slice(0, slash);
      step = Number(piece.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) throw new Error("cron 不合法");
    }
    let start = min;
    let end = max;
    if (body === "*") {
      // 全段
    } else if (body.includes("-")) {
      const [left, right] = body.split("-", 2);
      start = Number(left);
      end = Number(right);
      if (start > end) throw new Error("cron 不合法");
    } else if (step === 1) {
      addCronValue(field, Number(body), dow);
      continue;
    } else {
      start = Number(body);
      end = max;
    }
    for (let value = start; value <= end; value += step) addCronValue(field, value, dow);
  }
  if (fieldValues(field).length === 0) throw new Error("cron 不合法");
  return field;
}

function addCronValue(field: CronField, value: number, dow: boolean): void {
  if (!Number.isInteger(value)) throw new Error("cron 不合法");
  if (dow && (value < 0 || value > 7)) throw new Error("cron 不合法");
  const resolved = dow && value === 7 ? 0 : value;
  if (resolved < field.min || resolved > field.max) throw new Error("cron 不合法");
  field.bits[resolved] = true;
}

function fieldValues(field: CronField): number[] {
  const out: number[] = [];
  for (let value = field.min; value <= field.max; value += 1) if (field.bits[value]) out.push(value);
  return out;
}

function coversAll(field: CronField): boolean {
  for (let value = field.min; value <= field.max; value += 1) if (!field.bits[value]) return false;
  return true;
}

/** Vixie 语义：日、星期两段都有限定时，命中任一即可。 */
function cronDayMatches(spec: CronSpec, dom: number, dow: number): boolean {
  const domOK = spec.dom.bits[dom] === true;
  const dowOK = spec.dow.bits[dow] === true;
  const domAny = coversAll(spec.dom);
  const dowAny = coversAll(spec.dow);
  if (domAny && dowAny) return true;
  if (domAny) return dowOK;
  if (dowAny) return domOK;
  return domOK || dowOK;
}

function replaceNames(raw: string, pairs: readonly (readonly [string, string])[]): string {
  const lower = raw.toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length; ) {
    let matched = false;
    for (const [name, value] of pairs) {
      const next = i + name.length;
      if (lower.startsWith(name, i) && (next === lower.length || !isNameChar(lower[next] ?? "")) && (i === 0 || !isNameChar(lower[i - 1] ?? ""))) {
        out += value;
        i = next;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += lower[i];
      i += 1;
    }
  }
  return out;
}

function isNameChar(ch: string): boolean {
  return /[a-z0-9]/i.test(ch);
}
