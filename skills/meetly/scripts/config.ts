// The owner's scheduling config: types, answer parsing and validation.
import { isZoomRoomUrl } from "./event.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { DAYS, type Day } from "./time.ts";

export { DAYS, type Day };

export type Calendar = { account: string; id: string };

// How the owner usually meets, used when a request names no format. Unset
// means ask, as before.
export const DEFAULT_FORMATS = ["meet", "in_person", "phone"] as const;
export type DefaultFormat = (typeof DEFAULT_FORMATS)[number];
export type FormatDurations = Partial<Record<DefaultFormat, number>>;

/** How long a meeting lasts when the request names no length: the owner's length for its format, else durationMin. */
export function durationFor(config: Pick<Config, "durationMin" | "formatDurations">, format?: string): number {
  return (format !== undefined && config.formatDurations?.[format as DefaultFormat]) || config.durationMin;
}

/** One format's length into the saved ones: `undefined` removes it, and no lengths left means none saved. */
export function mergeDurations(current: FormatDurations | undefined, patch: FormatDurations): FormatDurations | undefined {
  const merged = { ...current, ...patch };
  for (const f of DEFAULT_FORMATS) if (merged[f] === undefined) delete merged[f];
  return Object.keys(merged).length ? merged : undefined;
}

export type Config = {
  ownerName: string;
  timezone: string;
  days: Day[];
  windowStart: string;
  windowEnd: string;
  durationMin: number;
  horizonDays: number;
  calendars: Calendar[];
  defaultAccount: string;
  // When enabled, inbound requests wait for owner approval before contacting the person.
  ownerGate?: boolean;
  // Words in the title of a block the owner lets Meetly offer times over.
  movable?: string[];
  // Minutes to leave free before and after an in-person meeting.
  travelMin?: number;
  // The owner's personal Zoom room; unset means Google Meet.
  zoomRoomUrl?: string;
  // Minutes of notice a time needs before it is offered; unset means MIN_NOTICE_MIN.
  minNoticeMin?: number;
  defaultFormat?: DefaultFormat;
  // Minutes a meeting of each format lasts when the request names no length; a format not listed uses durationMin.
  formatDurations?: FormatDurations;
  setupDoneAt?: string;
  paused?: boolean;
};

// Every setting the owner can change.
export const FIELDS = ["ownerName", "timezone", "days", "window", "durationMin", "horizonDays", "calendars", "ownerGate", "movable", "travel", "videoProvider", "minNotice", "defaultFormat", "formatDuration"] as const;
export type Field = (typeof FIELDS)[number];

// What setup cannot start without, in the order it asks: nobody but the owner,
// Plow or the Mac can answer them. The other settings start at DEFAULTS and
// change only when the owner says so.
export const REQUIRED_FIELDS = ["ownerName", "timezone", "calendars"] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export const DEFAULTS = {
  days: ["mon", "tue", "wed", "thu", "fri"] as Day[],
  windowStart: "09:00",
  windowEnd: "18:00",
  durationMin: 30,
  horizonDays: 14,
  // Inbound contacts never receive an offer until the owner approves it.
  ownerGate: true,
};

export const QUESTIONS: Record<RequiredField, string> = {
  ownerName: "When I talk to other people for you, I write about you by name, like \"Ana is free at 3pm\". What name should I use?",
  timezone: "What time zone are you in?",
  calendars: "Which of your calendars should count as busy?",
};

export const MIN_NOTICE_MIN = 120;
const MAX_NOTICE_MIN = 72 * 60;
export const STEP_MIN = 30;
export const SLOT_COUNT = 3;

export function holdHours(): number {
  const n = Number(process.env.MEETLY_HOLD_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

// How many minutes before a Meet its link is posted in the group.
export function reminderLeadMin(): number {
  const n = Number(process.env.MEETLY_REMINDER_LEAD_MIN || NaN);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function isField(name: string): name is Field {
  return (FIELDS as readonly string[]).includes(name);
}

const pad = (n: number) => String(n).padStart(2, "0");

// "9", "9h", "9:30", "9h30", "09:00" → "HH:MM".
export function parseTime(raw: string): string {
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?$/i.exec(raw.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m?.[2] ? Number(m[2]) : 0;
  if (!m || hh > 23 || mm > 59) throw new Error(`not a time: "${raw}" (use HH:MM, like 09:00)`);
  return `${pad(hh)}:${pad(mm)}`;
}

export function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function integer(raw: string, what: string, min: number, max: number): number {
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || n < min || n > max) {
    throw new Error(`${what} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// The calendars to read, by the ids `plow-gog calendar events --calendars`
// accepts. Holds are created on the default account's primary calendar, so it
// always counts as busy; a Google account's primary calendar id is the
// account's own address, and the `primary` alias, which the hold commands take,
// is not a name the events listing recognizes. Duplicates are dropped.
export function readableCalendars(calendars: Calendar[], defaultAccount: string): Calendar[] {
  if (!Array.isArray(calendars) || typeof defaultAccount !== "string" || !defaultAccount) return calendars;
  const out: Calendar[] = [];
  for (const c of [...calendars, { account: defaultAccount, id: defaultAccount }]) {
    const id = c.id === "primary" ? c.account : c.id;
    if (!out.some((o) => o.account === c.account && o.id === id)) out.push({ account: c.account, id });
  }
  return out;
}

export function parseField(field: string, value: string): Partial<Config> {
  switch (field) {
    case "ownerName": {
      const name = value.trim();
      if (name.length < 1 || name.length > 60) throw new Error("the name must be 1 to 60 characters");
      return { ownerName: name };
    }
    case "timezone": {
      const tz = value.trim();
      try {
        if (!tz) throw new Error();
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`unknown time zone: ${value} (use an IANA name like America/Sao_Paulo)`);
      }
      return { timezone: tz };
    }
    case "days": {
      const picked = new Set<Day>();
      for (const word of value.split(/[\s,]+/).filter(Boolean)) {
        const day = word.slice(0, 3).toLowerCase();
        if (!(DAYS as readonly string[]).includes(day)) throw new Error(`not a day of the week: "${word}"`);
        picked.add(day as Day);
      }
      if (picked.size === 0) throw new Error("pick at least one day");
      return { days: DAYS.filter((d) => picked.has(d)) };
    }
    case "window": {
      // Times never contain these letters, so splitting on them is safe.
      const parts = value.trim().split(/\s*(?:[-–—]|to|até|a)\s*/i).filter(Boolean);
      if (parts.length !== 2) throw new Error(`give a start and an end, like 09:00-18:00 (got "${value}")`);
      const windowStart = parseTime(parts[0]!);
      const windowEnd = parseTime(parts[1]!);
      if (minutes(windowStart) >= minutes(windowEnd)) throw new Error(`the window must start before it ends (${windowStart}-${windowEnd})`);
      return { windowStart, windowEnd };
    }
    case "durationMin":
      return { durationMin: integer(value, "the duration in minutes", 15, 240) };
    case "horizonDays":
      return { horizonDays: integer(value, "the number of days", 1, 30) };
    case "ownerGate": {
      const v = value.trim().toLowerCase();
      if (["on", "yes", "true", "enabled"].includes(v)) return { ownerGate: true };
      if (["off", "no", "false", "disabled"].includes(v)) return { ownerGate: false };
      throw new Error(`ownerGate must be on or off, got "${value}"`);
    }
    case "movable": {
      if (value.trim().toLowerCase() === "none") return { movable: undefined };
      const words = [...new Set(value.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean))];
      if (words.length === 0 || words.length > 20 || words.some((w) => w.length < 2 || w.length > 40)) {
        throw new Error(`movable is 1 to 20 words of 2 to 40 characters from the titles of blocks that may move, separated by commas (or none), got "${value}"`);
      }
      return { movable: words };
    }
    case "travel": {
      const raw = value.trim().toLowerCase();
      if (raw === "none" || raw === "0") return { travelMin: undefined };
      let minutes: number;
      const hours = /^(\d+(?:\.\d+)?)\s*h$/.exec(raw);
      const mins = /^(\d+)\s*(?:min(?:ute)?s?)?$/.exec(raw);
      if (hours) minutes = Number(hours[1]) * 60;
      else if (mins) minutes = Number(mins[1]);
      else throw new Error(`travel must be 1 to 180 minutes (or hours), or none, got "${value}"`);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
        throw new Error(`travel must be 1 to 180 minutes, got "${value}"`);
      }
      return { travelMin: minutes };
    }
    case "videoProvider": {
      const v = value.trim();
      if (v === "meet") return { zoomRoomUrl: undefined };
      if (!isZoomRoomUrl(v)) throw new Error(`the video provider is meet, or your Zoom room link (https://zoom.us/j/... or /my/...), got "${value}"`);
      return { zoomRoomUrl: v };
    }
    case "minNotice": {
      const raw = value.trim().toLowerCase();
      if (raw === "default") return { minNoticeMin: undefined };
      const m = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/.exec(raw);
      const minutesAhead = m ? Math.round(Number(m[1]) * (m[2] && m[2].startsWith("m") ? 1 : 60)) : NaN;
      if (!(minutesAhead >= 0 && minutesAhead <= MAX_NOTICE_MIN)) {
        throw new Error(`the notice must be 0 to ${MAX_NOTICE_MIN / 60} hours, like 3h or 90 min (or default), got "${value}"`);
      }
      return { minNoticeMin: minutesAhead };
    }
    case "defaultFormat": {
      const format = value.trim();
      if (format === "ask") return { defaultFormat: undefined };
      if (!(DEFAULT_FORMATS as readonly string[]).includes(format)) throw new Error(`the meeting format must be meet, in_person, phone or ask, got "${value}"`);
      return { defaultFormat: format as DefaultFormat };
    }
    case "formatDuration": {
      // "in_person 60", "phone=15 min", or "meet default" to go back to durationMin.
      const m = /^\s*(meet|in_person|phone)\s*[=:\s]\s*(default|\d+)\s*(?:min(?:ute)?s?)?\s*$/i.exec(value);
      if (!m) throw new Error(`formatDuration is a format (meet, in_person or phone) and its minutes or default, like "in_person 60", got "${value}"`);
      const format = m[1]!.toLowerCase() as DefaultFormat;
      if (m[2]!.toLowerCase() === "default") return { formatDurations: { [format]: undefined } };
      return { formatDurations: { [format]: integer(m[2]!, `the ${format} duration in minutes`, 15, 240) } };
    }
    case "calendars": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('calendars must be JSON: {"defaultAccount": "...", "calendars": [{"account": "...", "id": "..."}]}');
      }
      const { defaultAccount, calendars } = (parsed ?? {}) as { defaultAccount?: unknown; calendars?: unknown };
      if (!nonEmpty(defaultAccount)) throw new Error("calendars needs a defaultAccount");
      if (!Array.isArray(calendars)) throw new Error("calendars needs a calendars list");
      const list: Calendar[] = calendars.map((c: { account?: unknown; id?: unknown } | null) => {
        if (!nonEmpty(c?.account) || !nonEmpty(c?.id)) throw new Error(`each calendar needs an account and an id: ${JSON.stringify(c)}`);
        return { account: c.account, id: c.id };
      });
      return { defaultAccount, calendars: readableCalendars(list, defaultAccount) };
    }
    default:
      throw new Error(`unknown field: ${field} (one of ${FIELDS.join(", ")})`);
  }
}

function has(draft: Partial<Config>, field: RequiredField): boolean {
  if (field === "calendars") return draft.calendars !== undefined && draft.defaultAccount !== undefined;
  return draft[field] !== undefined;
}

export function nextField(draft: Partial<Config>): RequiredField | undefined {
  return REQUIRED_FIELDS.find((f) => !has(draft, f));
}

export function validateConfig(partial: Partial<Config>): Config {
  const missing = REQUIRED_FIELDS.filter((f) => !has(partial, f));
  if (missing.length) throw new Error(`setup is missing: ${missing.join(", ")}`);
  const p = { ...DEFAULTS, ...partial } as Config;
  const windowMin = minutes(p.windowEnd) - minutes(p.windowStart);
  if (windowMin <= 0) throw new Error("the window must start before it ends");
  if (p.durationMin > windowMin) {
    throw new Error(`a ${p.durationMin}-minute meeting is longer than the ${p.windowStart}-${p.windowEnd} window`);
  }
  const config: Config = {
    ownerName: p.ownerName,
    timezone: p.timezone,
    days: p.days,
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    durationMin: p.durationMin,
    horizonDays: p.horizonDays,
    calendars: p.calendars,
    defaultAccount: p.defaultAccount,
  };
  if (p.ownerGate !== undefined && typeof p.ownerGate !== "boolean") throw new Error("ownerGate must be true or false");
  config.ownerGate = p.ownerGate;
  if (p.movable !== undefined) config.movable = p.movable;
  if (p.travelMin !== undefined) {
    if (!Number.isInteger(p.travelMin) || p.travelMin < 1 || p.travelMin > 180) {
      throw new Error(`travel must be 1 to 180 minutes, got ${JSON.stringify(p.travelMin)}`);
    }
    config.travelMin = p.travelMin;
  }
  if (p.zoomRoomUrl !== undefined) config.zoomRoomUrl = p.zoomRoomUrl;
  if (p.minNoticeMin !== undefined) config.minNoticeMin = p.minNoticeMin;
  if (p.defaultFormat !== undefined) config.defaultFormat = p.defaultFormat;
  if (p.formatDurations !== undefined) {
    for (const [format, min] of Object.entries(p.formatDurations)) {
      if (!(DEFAULT_FORMATS as readonly string[]).includes(format)) throw new Error(`formatDurations has an unknown format: ${format}`);
      if (!Number.isInteger(min) || min! < 15 || min! > 240) throw new Error(`the ${format} duration must be 15 to 240 minutes, got ${JSON.stringify(min)}`);
      if (min! > windowMin) throw new Error(`a ${min}-minute ${format} meeting is longer than the ${p.windowStart}-${p.windowEnd} window`);
    }
    config.formatDurations = mergeDurations(undefined, p.formatDurations);
  }
  if (p.setupDoneAt !== undefined) config.setupDoneAt = p.setupDoneAt;
  if (p.paused !== undefined) config.paused = p.paused;
  return normalizeConfig(config);
}

export function normalizeConfig(config: Config): Config {
  return {
    ...config,
    ownerGate: config.ownerGate ?? DEFAULTS.ownerGate,
    calendars: readableCalendars(config.calendars, config.defaultAccount),
  };
}

export function loadConfig(): Config {
  const config = readJson<Config | null>(file("config.json"), null);
  if (!config?.setupDoneAt) throw new Error("Meetly is not set up yet");
  return normalizeConfig(config);
}
