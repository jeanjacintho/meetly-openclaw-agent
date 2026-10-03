import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addRequest, updateRequest, type Ledger, type NewRequest, type Patch, type Request } from "../skills/meetly/scripts/ledger.ts";
import { parseEvent, type EventInfo } from "../skills/meetly/scripts/event.ts";
import { checkReminder, markSent } from "../skills/meetly/scripts/reminder-check.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures", "calendar");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
const MIN = 60_000;
const T0 = Date.parse("2026-09-28T12:00:00Z");
const ACCOUNT = "owner@example.com";
const TZ = "America/Sao_Paulo";
const MEET = "https://meet.google.com/sai-nvgi-cdg";
// The fixture event: Sat 10/10 04:00–04:30 in São Paulo.
const START = Date.parse("2026-10-10T04:00:00-03:00");
const offer = { start: "2026-10-10T04:00:00-03:00", end: "2026-10-10T04:30:00-03:00", holdId: "evt123abc", account: ACCOUNT };
const input = (over: Record<string, unknown> = {}) => ({
  origin: "inbound", handle: "+15551234567", name: "Patrick", topic: "coffee", durationMin: 30, offered: [offer],
  chatUid: "c1", format: "meet", locale: "pt-BR", ...over,
}) as NewRequest;

function bookedMeet(over: Patch = {}, add: Record<string, unknown> = {}): Request {
  let l: Ledger = addRequest({ requests: [] }, input(add), T0, "r_1");
  l = updateRequest(l, "r_1", {
    status: "booked", eventId: "evt123abc", booked: { start: offer.start, end: offer.end, account: ACCOUNT }, meetUrl: MEET, ...over,
  }, T0);
  return l.requests[0]!;
}
const event = (over: Partial<EventInfo> = {}): EventInfo => ({ ...parseEvent(fixture("event-meet")), ...over });
const check = (r: Request, e: EventInfo, now: number) => checkReminder(r, e, now, { leadMin: 10, tz: TZ });

test("in the window, the link is sent to the group with the time in the person's language", () => {
  const out = check(bookedMeet(), event(), START - 8 * MIN);
  assert.equal(out.action, "send");
  assert.deepEqual(out.patch, {});
  assert.deepEqual(out.send, {
    chatUid: "c1", meetUrl: MEET, name: "Patrick", locale: "pt-BR", time: "04:00", minutesToStart: 8,
  });
});

test("a booking in the owner's Zoom room sends that room, and a cancelled event sends nothing", () => {
  const room = "https://zoom.us/j/123456789";
  const zoom = bookedMeet({ meetUrl: null, roomUrl: room });
  const noLink = event({ meetUrl: null });
  const out = check(zoom, noLink, START - 8 * MIN);
  assert.equal(out.action, "send");
  assert.equal(out.send!.meetUrl, room);
  assert.equal(check(zoom, event({ meetUrl: null, status: "cancelled" }), START - 8 * MIN).action, "cancelled");
  // Neither a Meet link nor a room: nothing to send.
  assert.equal(check(bookedMeet({ meetUrl: null }), noLink, START - 8 * MIN).action, "no-link");
});

test("the time is written in the owner's zone and the person's locale", () => {
  const out = check(bookedMeet({ locale: "en-US" }), event(), START - 5 * MIN);
  assert.equal(out.send!.time, "04:00 AM");
  const noLocale = check(bookedMeet({}, { locale: undefined }), event(), START - 5 * MIN);
  assert.equal(noLocale.send!.locale, "en-US");
});

test("a late poll still sends up to five minutes after the start, with no negative countdown", () => {
  const out = check(bookedMeet(), event(), START + 3 * MIN);
  assert.equal(out.action, "send");
  assert.equal(out.send!.minutesToStart, 0);
  assert.equal(check(bookedMeet(), event(), START + 5 * MIN).action, "wait");
});

test("too early is wait, and nothing changes", () => {
  const out = check(bookedMeet(), event(), START - 11 * MIN);
  assert.equal(out.action, "wait");
  assert.deepEqual(out.patch, {});
});

test("a deleted or cancelled event is recorded as cancelled and nothing is sent", () => {
  const out = check(bookedMeet(), parseEvent(fixture("event-cancelled")), START - 5 * MIN);
  assert.equal(out.action, "cancelled");
  assert.equal(out.send, undefined);
  assert.deepEqual(out.patch, { status: "cancelled", reminder: { at: new Date(START - 5 * MIN).toISOString(), outcome: "cancelled" } });
});

test("a Meet removed from the event is recorded as no-link, for the owner to hear about", () => {
  const out = check(bookedMeet(), event({ meetUrl: null }), START - 5 * MIN);
  assert.equal(out.action, "no-link");
  assert.equal(out.send, undefined);
  assert.equal(out.patch.reminder!.outcome, "no-link");
});

test("a regenerated link replaces the saved one and is the one sent", () => {
  const fresh = "https://meet.google.com/new-link-abc";
  const out = check(bookedMeet(), event({ meetUrl: fresh }), START - 5 * MIN);
  assert.equal(out.action, "send");
  assert.equal(out.send!.meetUrl, fresh);
  assert.equal(out.patch.meetUrl, fresh);
});

test("a meeting moved later: the new time is saved and the reminder waits for it", () => {
  const later = { start: "2026-10-10T05:00:00-03:00", end: "2026-10-10T05:30:00-03:00" };
  const out = check(bookedMeet(), event(later), START - 5 * MIN);
  assert.equal(out.action, "wait");
  assert.deepEqual(out.patch, { booked: { ...later, account: ACCOUNT } });
});

test("a meeting moved a little: sent now, for the new time", () => {
  const moved = { start: "2026-10-10T04:05:00-03:00", end: "2026-10-10T04:35:00-03:00" };
  const out = check(bookedMeet(), event(moved), START - 3 * MIN);
  assert.equal(out.action, "send");
  assert.equal(out.send!.time, "04:05");
  assert.equal(out.send!.minutesToStart, 8);
  assert.deepEqual(out.patch.booked, { ...moved, account: ACCOUNT });
});

test("a meeting moved into the past is never sent", () => {
  const earlier = { start: "2026-10-10T02:00:00-03:00", end: "2026-10-10T02:30:00-03:00" };
  assert.equal(check(bookedMeet(), event(earlier), START - 5 * MIN).action, "wait");
});

test("a group that never linked sends the link to the owner instead", () => {
  const out = check(bookedMeet({}, { chatUid: undefined }), event(), START - 5 * MIN);
  assert.equal(out.action, "send");
  assert.equal(out.send!.chatUid, null);
});

test("skip: already handled, not booked, not a Meet", () => {
  const sent = bookedMeet({ reminder: { at: new Date(T0).toISOString(), outcome: "sent" } });
  assert.equal(check(sent, event(), START - 5 * MIN).action, "skip");
  assert.equal(check(bookedMeet({ status: "dropped" }), event(), START - 5 * MIN).action, "skip");
  assert.equal(check(bookedMeet({ format: "in_person", meetUrl: null }), event(), START - 5 * MIN).action, "skip");
  assert.deepEqual(check(sent, event(), START - 5 * MIN).patch, {});
});

test("the event file must be this request's event", () => {
  assert.throws(() => check(bookedMeet(), event({ id: "someone-else" }), START - 5 * MIN), /not this request's event/);
});

test("markSent records the send once; a second mark is refused", () => {
  let l: Ledger = { requests: [bookedMeet()] };
  l = markSent(l, "r_1", START - 5 * MIN);
  assert.deepEqual(l.requests[0]!.reminder, { at: new Date(START - 5 * MIN).toISOString(), outcome: "sent" });
  assert.throws(() => markSent(l, "r_1", START), /already/);
  assert.throws(() => markSent(l, "nope", START), /no request/);
});

// End to end through the CLIs: book, wait, send, mark, and never twice.
test("CLI: the poll's full reminder sequence", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  writeJson(join(home, "config.json"), {
    ownerName: "Ana", timezone: TZ, days: ["mon"], windowStart: "09:00", windowEnd: "18:00", durationMin: 30, horizonDays: 7,
    calendars: [{ account: ACCOUNT, id: ACCOUNT }], defaultAccount: ACCOUNT, setupDoneAt: new Date(T0).toISOString(),
  });
  // A Meet five minutes from now, so the real clock is inside the window.
  const start = Date.now() + 5 * MIN;
  const iso = (ms: number) => new Date(ms).toISOString();
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(input())], env);
  const id = saved.json.request.id;
  const raw = JSON.parse(fixture("event-meet").slice(fixture("event-meet").indexOf("{")));
  raw.event.start.dateTime = iso(start);
  raw.event.end.dateTime = iso(start + 30 * MIN);
  const eventFile = join(home, "event.txt");
  writeFileSync(eventFile, JSON.stringify(raw));
  assert.equal(cli("record-booking.ts", ["--id", id, "--event-file", eventFile, "--account", ACCOUNT], env).status, 0);

  const due = cli("ledger.ts", ["reminders"], env);
  assert.deepEqual(due.json.requests.map((r: { id: string }) => r.id), [id]);
  const decided = cli("reminder-check.ts", ["--id", id, "--event-file", eventFile], env);
  assert.equal(decided.status, 0, decided.stderr);
  assert.equal(decided.json.action, "send");
  assert.equal(decided.json.send.meetUrl, MEET);
  assert.equal(decided.json.send.chatUid, "c1");
  assert.ok(decided.json.send.minutesToStart >= 4 && decided.json.send.minutesToStart <= 5);

  const marked = cli("reminder-check.ts", ["--id", id, "--sent"], env);
  assert.equal(marked.status, 0, marked.stderr);
  assert.equal(marked.json.request.reminder.outcome, "sent");
  assert.deepEqual(cli("ledger.ts", ["reminders"], env).json, { requests: [] });
  assert.equal(cli("reminder-check.ts", ["--id", id, "--event-file", eventFile], env).json.action, "skip");
  assert.equal(cli("reminder-check.ts", ["--id", id, "--sent"], env).status, 1);

  const usage = cli("reminder-check.ts", ["--id", id], env);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage/);
});

test("CLI: a cancelled event is written to the ledger so the next poll skips it", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  writeJson(join(home, "config.json"), {
    ownerName: "Ana", timezone: TZ, days: ["mon"], windowStart: "09:00", windowEnd: "18:00", durationMin: 30, horizonDays: 7,
    calendars: [{ account: ACCOUNT, id: ACCOUNT }], defaultAccount: ACCOUNT, setupDoneAt: new Date(T0).toISOString(),
  });
  const id = cli("ledger.ts", ["save", "--json", JSON.stringify(input())], env).json.request.id;
  const eventFile = join(home, "event.txt");
  writeFileSync(eventFile, fixture("event-meet"));
  cli("record-booking.ts", ["--id", id, "--event-file", eventFile, "--account", ACCOUNT], env);
  writeFileSync(eventFile, fixture("event-cancelled"));
  const out = cli("reminder-check.ts", ["--id", id, "--event-file", eventFile], env);
  assert.equal(out.json.action, "cancelled");
  const cancelled = cli("ledger.ts", ["find", "--chat", "c1"], env).json.request;
  assert.equal(cancelled.reminder.outcome, "cancelled");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.closedAt, cancelled.updatedAt);
});
