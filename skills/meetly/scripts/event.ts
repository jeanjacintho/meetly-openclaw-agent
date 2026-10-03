// Reads one Google Calendar event as plow-gog prints it (`calendar create`,
// `update` or `event` with --json), and the only Meet link Meetly will ever
// post. The agent saves the command's output to a file; this parses it so no
// turn has to pick a link or a status out of the JSON by eye.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";

export type EventStatus = "confirmed" | "tentative" | "cancelled";
// `roomUrl` is the owner's Zoom room as the live event's location says it, so a
// room is only ever sent while the calendar still shows it.
export type EventInfo = { id: string; status: EventStatus; start: string; end: string; meetUrl: string | null; roomUrl: string | null };

const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const STATUSES: readonly EventStatus[] = ["confirmed", "tentative", "cancelled"];

// Anything else (another host, a query string, a Zoom link) is refused, so a
// link written into a message or an event by someone else never reaches a
// reminder.
export function isMeetUrl(value: unknown): value is string {
  return typeof value === "string" && MEET_URL.test(value);
}

// The owner's personal Zoom room, only ever from their own configuration: an
// https zoom.us meeting or personal link, with at most a pwd. Meetly cannot
// create a Zoom link and never takes one from a message.
const ZOOM_ROOM_URL = /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/(j|my)\/[A-Za-z0-9_.-]+(\?pwd=[A-Za-z0-9._-]+)?$/;
export function isZoomRoomUrl(value: unknown): value is string {
  return typeof value === "string" && ZOOM_ROOM_URL.test(value);
}

type RawEvent = {
  id?: unknown;
  status?: unknown;
  start?: { dateTime?: unknown };
  end?: { dateTime?: unknown };
  hangoutLink?: unknown;
  location?: unknown;
  conferenceData?: { entryPoints?: { entryPointType?: unknown; uri?: unknown }[] };
};

// gog prints a "Note: …" line before the JSON; plow_run_command wraps it all
// in {exit_code, output}. Both are unwrapped here.
function toObject(text: string): Record<string, unknown> {
  const at = text.indexOf("{");
  if (at < 0) throw new Error("no JSON object in the calendar output");
  let value: unknown;
  try {
    value = JSON.parse(text.slice(at));
  } catch (err) {
    throw new Error(`the calendar output is not JSON (${(err as Error).message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the calendar output is not an object");
  const obj = value as Record<string, unknown>;
  if (typeof obj.output === "string" && obj.event === undefined && obj.id === undefined) return toObject(obj.output);
  return obj;
}

function meetLink(e: RawEvent): string | null {
  if (isMeetUrl(e.hangoutLink)) return e.hangoutLink;
  const video = (e.conferenceData?.entryPoints ?? []).find((p) => p?.entryPointType === "video" && isMeetUrl(p.uri));
  return video ? (video.uri as string) : null;
}

export function parseEvent(text: string): EventInfo {
  const obj = toObject(text);
  const e = (obj.event ?? obj) as RawEvent;
  if (typeof e !== "object" || e === null) throw new Error("no event in the calendar output");
  if (typeof e.id !== "string" || !e.id) throw new Error("the calendar output has no event id");
  const status = e.status === undefined ? "confirmed" : e.status;
  if (!STATUSES.includes(status as EventStatus)) throw new Error(`unknown event status: ${String(status)}`);
  const start = e.start?.dateTime;
  const end = e.end?.dateTime;
  if (typeof start !== "string" || typeof end !== "string") throw new Error("the event has no start and end time (an all-day event?)");
  const s = Date.parse(start);
  const t = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(t)) throw new Error(`the event times are not dates: ${start}, ${end}`);
  if (t <= s) throw new Error(`the event ends before it starts: ${start}, ${end}`);
  return { id: e.id, status: status as EventStatus, start, end, meetUrl: meetLink(e), roomUrl: isZoomRoomUrl(e.location) ? e.location : null };
}

export function readEvent(path: string): EventInfo {
  return parseEvent(readFileSync(path, "utf8"));
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({ options: { in: { type: "string" } } });
    if (!values.in) throw new Error("usage: event.ts --in <file with plow-gog's output>");
    return readEvent(values.in);
  });
}
