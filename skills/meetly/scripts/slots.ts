// Free times to offer: the owner's days and window, in the owner's zone,
// clear of busy time, at least the owner's notice ahead (MIN_NOTICE_MIN unless
// they set one), spread across days.
// The label and weekday come from here so the agent never computes a weekday.
// A request only narrows the owner's days and window. A time outside them is
// never offered: when the other person can only do such a time, --at checks
// it and the owner must confirm it before anything is held or booked.
// With a locale (the other person's, e.g. pt-BR or en-US) the label follows
// that locale's date and time conventions; without one it is "tue 29/9 12:00".
import { parseArgs } from "node:util";
import { isMain, readInput, run } from "./cli.ts";
import { durationFor, loadConfig, MIN_NOTICE_MIN, minutes, parseTime, SLOT_COUNT, STEP_MIN, type Config } from "./config.ts";
import type { Busy } from "./busy.ts";
import { addDays, DAYS, localIso, wallParts, zonedToUtc, type Day } from "./time.ts";

// `overlaps`: ids of the blocks this time sits over because the request allows them or the owner marked them movable.
type TravelWindow = { start: string; end: string };
export type Slot = { start: string; end: string; dayOfWeek: Day; label: string; overlaps?: string[]; travel?: { before: TravelWindow; after: TravelWindow } };

export type SlotQuery = {
  now: number;
  config: Config;
  busy: Busy[];
  unknownAfter?: string;
  durationMin?: number;
  days?: Day[];
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  allowOverlap?: string[];
  exclude?: string[];
  count?: number;
  locale?: string;
  // Leave the owner's configured travel time free around the meeting.
  travel?: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");

// Throws on a malformed locale tag, so the CLI fails instead of guessing.
export function localeFormatter(locale: string, tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    throw new Error(`unknown locale: ${locale} (use a tag like pt-BR or en-US)`);
  }
}

function label(ms: number, tz: string, format?: Intl.DateTimeFormat): string {
  if (format) return format.format(new Date(ms));
  const p = wallParts(ms, tz);
  return `${p.weekday} ${p.d}/${p.m} ${pad(p.hh)}:${pad(p.mm)}`;
}

// A block the owner lets a meeting overlap: listed as movable, or named in the request.
const softBusy = (ids: string[] = []) => {
  const allowed = new Set(ids);
  return (b: Busy) => b.movable === true || (b.id !== undefined && allowed.has(b.id));
};

// The travel blocks around a meeting, as UTC instants, when a buffer is set.
const travelWindow = (start: number, end: number, travelMin: number) => {
  if (travelMin === 0) return {};
  const utc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  return { travel: {
    before: { start: utc(start - travelMin * 60_000), end: utc(start) },
    after: { start: utc(end), end: utc(end + travelMin * 60_000) },
  } };
};

export function findSlots(q: SlotQuery): { slots: Slot[]; unknownAfter?: string } {
  const { config, now } = q;
  const tz = config.timezone;
  const duration = q.durationMin ?? config.durationMin;
  const travelMin = q.travel ? config.travelMin ?? 0 : 0;
  const count = q.count ?? SLOT_COUNT;

  const days = q.days ? config.days.filter((d) => q.days!.includes(d)) : config.days;
  // Keep both travel blocks inside the owner's working window only: the
  // attendee's own after/before apply to the meeting, not to the owner's trip.
  let startMin = minutes(config.windowStart) + travelMin;
  let endMin = minutes(config.windowEnd) - travelMin;
  if (q.after) startMin = Math.max(startMin, minutes(q.after));
  if (q.before) endMin = Math.min(endMin, minutes(q.before));
  startMin = Math.ceil(startMin / STEP_MIN) * STEP_MIN;

  const earliest = now + ((config.minNoticeMin ?? MIN_NOTICE_MIN) + travelMin) * 60_000;
  const excluded = new Set((q.exclude ?? []).map((e) => Date.parse(e)));
  const isSoft = softBusy(q.allowOverlap);
  const ranges = (list: Busy[]) => list.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end), id: b.id }));
  const busy = ranges(q.busy.filter((b) => !isSoft(b)));
  const soft = ranges(q.busy.filter(isSoft));
  const unknownAfter = q.unknownAfter !== undefined ? Date.parse(q.unknownAfter) : undefined;

  const today = wallParts(now, tz);
  const perDay: { start: number; end: number; day: Day; overlaps: string[] }[][] = [];
  scan: for (let i = 0; i <= config.horizonDays; i++) {
    const { y, m, d } = addDays(today.y, today.m, today.d, i);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if ((q.from && date < q.from) || (q.to && date > q.to)) continue;
    const day = wallParts(zonedToUtc(y, m, d, 12, 0, tz), tz).weekday;
    if (!days.includes(day)) continue;
    const found: { start: number; end: number; day: Day; overlaps: string[] }[] = [];
    for (let t = startMin; t + duration <= endMin; t += STEP_MIN) {
      const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      const end = start + duration * 60_000;
      const bufferStart = start - travelMin * 60_000;
      const bufferEnd = end + travelMin * 60_000;
      if (unknownAfter !== undefined && bufferEnd > unknownAfter) {
        perDay.push(found);
        break scan;
      }
      if (start < earliest || excluded.has(start)) continue;
      if (busy.some((b) => b.start < bufferEnd && b.end > bufferStart)) continue;
      found.push({ start, end, day, overlaps: [...new Set(soft.filter((b) => b.start < bufferEnd && b.end > bufferStart && b.id !== undefined).map((b) => b.id!))] });
    }
    perDay.push(found);
  }

  // One per day first, soonest days first; then fill in time order.
  const picked = perDay.filter((f) => f.length > 0).map((f) => f[0]!).slice(0, count);
  if (picked.length < count) {
    const rest = perDay.flat().filter((c) => !picked.includes(c));
    picked.push(...rest.slice(0, count - picked.length));
  }
  picked.sort((a, b) => a.start - b.start);

  const format = q.locale !== undefined ? localeFormatter(q.locale, tz) : undefined;
  const slots = picked.map((c) => ({
    start: localIso(c.start, tz),
    end: localIso(c.end, tz),
    dayOfWeek: c.day,
    label: label(c.start, tz, format),
    ...(c.overlaps.length > 0 ? { overlaps: c.overlaps } : {}),
    ...travelWindow(c.start, c.end, travelMin),
  }));
  return q.unknownAfter !== undefined ? { slots, unknownAfter: q.unknownAfter } : { slots };
}

export type TimeCheck = {
  slot: Slot;
  free: boolean;
  reason?: "busy" | "too-soon" | "unknown";
  outsideHours: boolean;
  overlaps?: string[];
};

// Checks one exact time the other person asked for. free: clear of busy time
// (except allowOverlap), with enough notice, and inside what was read.
// outsideHours: not on the owner's days or not inside the window, so the
// owner must confirm before it is held or booked.
export function checkTime(q: {
  now: number;
  config: Config;
  busy: Busy[];
  start: string;
  unknownAfter?: string;
  durationMin?: number;
  allowOverlap?: string[];
  locale?: string;
  travel?: boolean;
}): TimeCheck {
  const tz = q.config.timezone;
  const travelMin = q.travel ? q.config.travelMin ?? 0 : 0;
  // A wall time with no offset (2026-10-03T10:00) is the owner's clock.
  const wall = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(q.start);
  const start = wall
    ? zonedToUtc(Number(wall[1]), Number(wall[2]), Number(wall[3]), Number(wall[4]), Number(wall[5]), tz)
    : Date.parse(q.start);
  if (Number.isNaN(start)) throw new Error(`not a time: ${q.start}`);
  const end = start + (q.durationMin ?? q.config.durationMin) * 60_000;
  const bufferStart = start - travelMin * 60_000;
  const bufferEnd = end + travelMin * 60_000;
  const s = wallParts(start, tz);
  const bs = wallParts(bufferStart, tz);
  const be = wallParts(bufferEnd, tz);
  const sameDay = bs.y === be.y && bs.m === be.m && bs.d === be.d;
  const outsideHours = !q.config.days.includes(bs.weekday) || !sameDay ||
    bs.hh * 60 + bs.mm < minutes(q.config.windowStart) || be.hh * 60 + be.mm > minutes(q.config.windowEnd);
  const isSoft = softBusy(q.allowOverlap);
  const overlapping = q.busy.filter((b) => Date.parse(b.start) < bufferEnd && Date.parse(b.end) > bufferStart);
  const overlaps = [...new Set(overlapping.filter((b) => isSoft(b) && b.id !== undefined).map((b) => b.id!))];
  let reason: TimeCheck["reason"];
  if (q.unknownAfter !== undefined && bufferEnd > Date.parse(q.unknownAfter)) reason = "unknown";
  else if (bufferStart < q.now + (q.config.minNoticeMin ?? MIN_NOTICE_MIN) * 60_000) reason = "too-soon";
  else if (overlapping.some((b) => !isSoft(b))) reason = "busy";
  const format = q.locale !== undefined ? localeFormatter(q.locale, tz) : undefined;
  const slot: Slot = {
    start: localIso(start, tz), end: localIso(end, tz), dayOfWeek: s.weekday, label: label(start, tz, format),
    ...travelWindow(start, end, travelMin),
  };
  const soft = overlaps.length > 0 ? { overlaps } : {};
  return reason ? { slot, free: false, reason, outsideHours, ...soft } : { slot, free: true, outsideHours, ...soft };
}

function positiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${flag} must be a positive whole number, got ${raw}`);
  return Number(raw);
}

function date(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${flag} must be YYYY-MM-DD, got ${raw}`);
  return raw;
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: {
        in: { type: "string" },
        duration: { type: "string" },
        format: { type: "string" },
        days: { type: "string" },
        after: { type: "string" },
        before: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "allow-overlap": { type: "string", multiple: true },
        exclude: { type: "string", multiple: true },
        count: { type: "string" },
        at: { type: "string" },
        now: { type: "string" },
        locale: { type: "string" },
        travel: { type: "boolean" },
      },
    });
    const config = loadConfig();
    const input = JSON.parse(readInput(values.in !== undefined ? [values.in] : [])[0]!) as {
      busy?: Busy[];
      unknownAfter?: string;
      degraded?: string[];
    };
    if (!Array.isArray(input.busy)) throw new Error("the busy input has no busy list (pass busy.ts output)");
    const now = values.now !== undefined ? Date.parse(values.now) : Date.now();
    if (Number.isNaN(now)) throw new Error(`--now is not a time: ${values.now}`);
    const degraded = input.degraded ?? [];
    // An explicit --duration wins; otherwise the owner's length for this format, which falls back to durationMin.
    const durationMin = values.duration !== undefined ? positiveInt(values.duration, "--duration") : durationFor(config, values.format);
    if (values.at !== undefined) {
      for (const flag of ["days", "after", "before", "from", "to", "exclude", "count"] as const) {
        if (values[flag] !== undefined) throw new Error(`--at checks one time; drop --${flag}`);
      }
      const check: Parameters<typeof checkTime>[0] = { now, config, busy: input.busy, start: values.at };
      if (input.unknownAfter !== undefined) check.unknownAfter = input.unknownAfter;
      check.durationMin = durationMin;
      if (values.travel) check.travel = true;
      if (values["allow-overlap"]) check.allowOverlap = values["allow-overlap"];
      if (values.locale !== undefined) check.locale = values.locale;
      const result = checkTime(check);
      // An account that could not be read may hold a hard conflict: never call the time free.
      return degraded.length ? { ...result, free: false, reason: "unknown", degraded } : { ...result, degraded };
    }
    const q: SlotQuery = { now, config, busy: input.busy };
    if (input.unknownAfter !== undefined) q.unknownAfter = input.unknownAfter;
    q.durationMin = durationMin;
    if (values.travel) q.travel = true;
    if (values.count !== undefined) q.count = positiveInt(values.count, "--count");
    if (values.days !== undefined) {
      q.days = values.days.split(/[\s,]+/).filter(Boolean).map((d) => {
        const day = d.slice(0, 3).toLowerCase();
        if (!(DAYS as readonly string[]).includes(day)) throw new Error(`not a day of the week: ${d}`);
        return day as Day;
      });
    }
    if (values.after !== undefined) q.after = parseTime(values.after);
    if (values.before !== undefined) q.before = parseTime(values.before);
    if (values.from !== undefined) q.from = date(values.from, "--from");
    if (values.to !== undefined) q.to = date(values.to, "--to");
    if (values["allow-overlap"]) q.allowOverlap = values["allow-overlap"];
    if (values.locale !== undefined) q.locale = values.locale;
    if (values.exclude) {
      for (const e of values.exclude) if (Number.isNaN(Date.parse(e))) throw new Error(`--exclude is not a time: ${e}`);
      q.exclude = values.exclude;
    }
    return { ...findSlots(q), degraded };
  });
}
