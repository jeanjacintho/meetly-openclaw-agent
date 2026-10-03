// Turns `plow-gog calendar events` output into busy intervals, from files or,
// with --fetch, read straight from the Mac into tmp/busy.json. Anything the
// read did not cover (a truncated listing, an account at --max, a degraded
// account) is reported, never treated as free.
import { parseArgs } from "node:util";
import { isMain, readInput, run } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";
import { file } from "./paths.ts";
import { status } from "./setup-status.ts";
import { writeJson } from "./store.ts";
import { zonedToUtc } from "./time.ts";

export type Busy = { start: string; end: string; id?: string; account?: string };
export type BusyResult = { busy: Busy[]; unknownAfter?: string; degraded: string[] };

type Stamp = string | { dateTime?: string; date?: string } | undefined;
export type CalEvent = {
  id?: string;
  account?: string;
  CalendarID?: string;
  summary?: string;
  startLocal?: string;
  endLocal?: string;
  start?: Stamp;
  end?: Stamp;
  allDay?: boolean;
  transparency?: string;
  declined?: boolean;
  status?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A date-only value is midnight in tz; anything else goes through Date.parse.
export function instant(value: string, tz: string): number {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return zonedToUtc(y!, m!, d!, 0, 0, tz);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not a date or time: ${JSON.stringify(value)}`);
  return ms;
}

export function stamp(local: string | undefined, raw: Stamp): string | undefined {
  if (local) return local;
  if (typeof raw === "string") return raw;
  return raw?.dateTime ?? raw?.date;
}

function eventsOf(result: unknown): { events: CalEvent[]; degraded: unknown[]; after?: string } {
  if (Array.isArray(result)) return { events: result, degraded: [] };
  const r = (result ?? {}) as { items?: unknown; events?: unknown; degraded?: unknown; truncated?: { after?: string } };
  const list = Array.isArray(r.items) ? r.items : Array.isArray(r.events) ? r.events : undefined;
  if (!list) throw new Error("calendar result has no items or events list");
  return { events: list, degraded: Array.isArray(r.degraded) ? r.degraded : [], after: r.truncated?.after };
}

function skipped(e: CalEvent): boolean {
  if (e.transparency === "transparent" || e.declined === true || e.status === "cancelled") return true;
  return (e.attendees ?? []).some((a) => a?.self === true && a.responseStatus === "declined");
}

export function toBusy(results: unknown[], opts: { tz: string; max: number }): BusyResult {
  const busy: Busy[] = [];
  const degraded: string[] = [];
  let unknownAfter: number | undefined;
  const unknownFrom = (ms: number) => {
    if (unknownAfter === undefined || ms < unknownAfter) unknownAfter = ms;
  };
  for (const result of results) {
    const { events, degraded: bad, after } = eventsOf(result);
    if (after) unknownFrom(instant(after, opts.tz));
    for (const d of bad) {
      if (typeof d === "string") degraded.push(d);
      else if (d && typeof (d as { account?: unknown }).account === "string") degraded.push((d as { account: string }).account);
      else degraded.push(JSON.stringify(d));
    }
    // Per account: how many items came back and the latest start among them.
    const perAccount = new Map<string, { count: number; last: number }>();
    for (const e of events) {
      const startRaw = stamp(e.startLocal, e.start);
      const endRaw = stamp(e.endLocal, e.end);
      if (!startRaw || !endRaw) throw new Error(`event ${e.id ?? "?"} has no start or end`);
      const allDay = e.allDay === true || DATE_ONLY.test(startRaw);
      const start = instant(allDay ? startRaw.slice(0, 10) : startRaw, opts.tz);
      const end = instant(allDay ? endRaw.slice(0, 10) : endRaw, opts.tz);
      const key = e.account ?? "";
      const seen = perAccount.get(key) ?? { count: 0, last: -Infinity };
      perAccount.set(key, { count: seen.count + 1, last: Math.max(seen.last, start) });
      if (skipped(e)) continue;
      const b: Busy = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
      if (e.id !== undefined) b.id = e.id;
      if (e.account !== undefined) b.account = e.account;
      busy.push(b);
    }
    for (const { count, last } of perAccount.values()) {
      if (count >= opts.max) unknownFrom(last);
    }
  }
  busy.sort((a, b) => a.start.localeCompare(b.start));
  const out: BusyResult = { busy, degraded };
  if (unknownAfter !== undefined) out.unknownAfter = new Date(unknownAfter).toISOString();
  return out;
}

// The listing after any notice plow-gog prints ahead of it ("Note: Using
// direct access token ..."): from the first line that opens the JSON.
function listingOf(output: string): unknown {
  const start = output.search(/^[[{]/m);
  if (start < 0) throw new Error("no JSON in the calendar listing");
  return JSON.parse(output.slice(start));
}

const FETCH_MAX = 100;

// Reads every configured account on the Mac directly (mac.ts), one
// `plow-gog calendar events` per account, so the listing never passes through
// the model. An account the Mac cannot read, or whose listing does not parse,
// is degraded. Every event is tagged with the account it was read from.
export async function listEvents(
  config: Pick<Config, "calendars">,
  range: { from: string; to: string },
  opts: BridgeOptions = {},
): Promise<{ events: CalEvent[]; degraded: string[]; incomplete: string[]; truncatedAfter: string[] }> {
  const byAccount = new Map<string, string[]>();
  for (const c of config.calendars) byAccount.set(c.account, [...(byAccount.get(c.account) ?? []), c.id]);
  const events: CalEvent[] = [];
  const degraded: string[] = [];
  // Accounts whose listing was cut short: read, but not all of it.
  const incomplete: string[] = [];
  const truncatedAfter: string[] = [];
  for (const [account, ids] of byAccount) {
    const output = await runOnMac({
      argv: ["plow-gog", "calendar", "events", "--calendars", ids.join(","), "--account", account,
        "--from", range.from, "--to", range.to, "--max", String(FETCH_MAX), "--json"],
      readPaths: [], timeoutMs: 60_000,
      goal: "Meetly: read your calendar so it only offers times you are free, and finds the meetings to change",
    }, opts).catch(() => undefined);
    try {
      if (output === undefined) throw new Error("unreadable");
      const listing = eventsOf(listingOf(output));
      events.push(...listing.events.map((e) => ({ ...e, account })));
      if (listing.after) truncatedAfter.push(listing.after);
      // Part of the listing could not be read: the account is not fully searched.
      if (listing.degraded.length > 0) degraded.push(account);
      else if (listing.after || listing.events.length >= FETCH_MAX) incomplete.push(account);
    } catch {
      degraded.push(account);
    }
  }
  return { events, degraded, incomplete, truncatedAfter };
}

export async function fetchBusy(
  config: Pick<Config, "timezone" | "calendars">,
  range: { from: string; to: string },
  opts: BridgeOptions = {},
): Promise<BusyResult> {
  const { events, degraded, truncatedAfter } = await listEvents(config, range, opts);
  const out = toBusy([{ events }, ...truncatedAfter.map((after) => ({ events: [], truncated: { after } }))], { tz: config.timezone, max: FETCH_MAX });
  out.degraded.push(...degraded);
  return out;
}

if (isMain(import.meta.url)) {
  run(async () => {
    const { values } = parseArgs({
      options: { in: { type: "string", multiple: true }, max: { type: "string", default: "100" }, fetch: { type: "boolean", default: false } },
    });
    if (values.fetch) {
      const current = status();
      if (current.status !== "READY") throw new Error("Meetly is not set up yet");
      const result = await fetchBusy(current.config, current.range);
      const out = file("tmp/busy.json");
      writeJson(out, result);
      const summary: { file: string; busy: number; degraded: string[]; unknownAfter?: string } = { file: out, busy: result.busy.length, degraded: result.degraded };
      if (result.unknownAfter) summary.unknownAfter = result.unknownAfter;
      return summary;
    }
    const max = Number(values.max);
    if (!Number.isInteger(max) || max <= 0) throw new Error(`--max must be a positive whole number, got ${values.max}`);
    const { timezone } = loadConfig();
    const results = readInput(values.in ?? []).map((text) => JSON.parse(text));
    return toBusy(results, { tz: timezone, max });
  });
}
