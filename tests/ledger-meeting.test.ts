// The meeting's format, its booked time, its Meet link and its reminder.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addRequest, dueReminders, saveRequest, updateRequest,
  type Ledger, type NewRequest, type Patch,
} from "../skills/meetly/scripts/ledger.ts";
import { reminderLeadMin } from "../skills/meetly/scripts/config.ts";
import { cli, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-09-28T12:00:00Z");
const MIN = 60_000;
const offer = { start: "2026-10-01T15:00:00-03:00", end: "2026-10-01T15:30:00-03:00", holdId: "h1", account: "owner@example.com" };
const input = (over: Record<string, unknown> = {}) => ({
  origin: "inbound", handle: "+15551234567", topic: "coffee", durationMin: 30, offered: [offer], ...over,
}) as NewRequest;
const empty = (): Ledger => ({ requests: [] });
const MEET = "https://meet.google.com/abc-defg-hij";
const booked = { start: "2026-10-01T15:00:00-03:00", end: "2026-10-01T15:30:00-03:00", account: "owner@example.com" };
const START = Date.parse(booked.start);

// A booked Meet with a link, ready for a reminder.
function bookedMeet(over: Patch = {}): Ledger {
  const l = addRequest(empty(), input({ format: "meet", locale: "pt-BR", chatUid: "c1" }), T0, "r_1");
  return updateRequest(l, "r_1", { status: "booked", eventId: "e1", booked, meetUrl: MEET, ...over }, T0);
}

test("format defaults to unknown, and is stored when given", () => {
  assert.equal(addRequest(empty(), input(), T0, "r_1").requests[0]!.format, "unknown");
  for (const format of ["meet", "in_person", "phone", "unknown"]) {
    assert.equal(addRequest(empty(), input({ format }), T0, "r_1").requests[0]!.format, format);
  }
});

test("a format that is not one of the four is refused on add and update", () => {
  for (const format of ["zoom", "video", "", "MEET", 1, null]) {
    assert.throws(() => addRequest(empty(), input({ format }), T0, "r_1"), /format/, String(format));
  }
  const l = addRequest(empty(), input(), T0, "r_1");
  assert.throws(() => updateRequest(l, "r_1", { format: "zoom" } as never, T0), /format/);
});

test("locale is stored, and must be a short tag", () => {
  assert.equal(addRequest(empty(), input({ locale: "pt-BR" }), T0, "r_1").requests[0]!.locale, "pt-BR");
  assert.throws(() => addRequest(empty(), input({ locale: "" }), T0, "r_1"), /locale/);
  assert.throws(() => addRequest(empty(), input({ locale: "x".repeat(36) }), T0, "r_1"), /locale/);
  assert.throws(() => addRequest(empty(), input({ locale: 5 }), T0, "r_1"), /locale/);
});

test("a re-offer keeps a format already answered unless it names a new one", () => {
  const first = addRequest(empty(), input({ format: "in_person", location: "Starbucks Paulista" }), T0, "r_1");
  const h2 = [{ ...offer, holdId: "h2" }];
  assert.equal(saveRequest(first, input({ offered: h2 }), T0, "r_2").requests[0]!.format, "in_person");
  assert.equal(saveRequest(first, input({ offered: h2, format: "unknown" }), T0, "r_2").requests[0]!.format, "in_person");
  assert.equal(saveRequest(first, input({ offered: h2, format: "meet" }), T0, "r_2").requests[0]!.format, "meet");
  // A brand new request still starts at unknown.
  assert.equal(saveRequest(empty(), input(), T0, "r_9").requests[0]!.format, "unknown");
});

test("update sets format, locale, booked, meetUrl and reminder", () => {
  const l = bookedMeet({ reminder: { at: new Date(T0).toISOString(), outcome: "sent" } });
  const r = l.requests[0]!;
  assert.equal(r.status, "booked");
  assert.deepEqual(r.booked, booked);
  assert.equal(r.meetUrl, MEET);
  assert.deepEqual(r.reminder, { at: new Date(T0).toISOString(), outcome: "sent" });
  assert.equal(updateRequest(l, "r_1", { locale: "en-US" }, T0).requests[0]!.locale, "en-US");
});

test("meetUrl only takes a Google Meet link", () => {
  const l = addRequest(empty(), input({ format: "meet" }), T0, "r_1");
  for (const bad of [
    "http://meet.google.com/abc-defg-hij",
    "https://meet.google.com.evil.example/abc-defg-hij",
    "https://zoom.us/j/1",
    "https://meet.google.com/abc-defg-hij?x=1",
    "https://meet.google.com/abcdefghij",
    "",
  ]) {
    assert.throws(() => updateRequest(l, "r_1", { meetUrl: bad }, T0), /meetUrl/, bad);
  }
});

const ROOM = "https://zoom.us/j/123456789";

test("roomUrl takes only a personal Zoom room, only on a video meeting, and clears with null", () => {
  const l = addRequest(empty(), input({ format: "meet" }), T0, "r_1");
  for (const bad of ["http://zoom.us/j/1", "https://zoom.us.evil.example/j/1", "https://meet.google.com/abc-defg-hij", "https://zoom.us/j/1?x=1", ""]) {
    assert.throws(() => updateRequest(l, "r_1", { roomUrl: bad }, T0), /roomUrl/, bad);
  }
  const withRoom = updateRequest(l, "r_1", { roomUrl: ROOM }, T0);
  assert.equal(withRoom.requests[0]!.roomUrl, ROOM);
  assert.equal("roomUrl" in updateRequest(withRoom, "r_1", { roomUrl: null }, T0).requests[0]!, false);
  // Moving to another format drops it; it cannot be set on one that is not a video meeting.
  assert.equal("roomUrl" in updateRequest(withRoom, "r_1", { format: "in_person", location: "Office" }, T0).requests[0]!, false);
  const phone = addRequest(empty(), input({ format: "phone" }), T0, "r_2");
  assert.throws(() => updateRequest(phone, "r_2", { roomUrl: ROOM }, T0), /roomUrl/);
});

test("a booked video meeting with the owner's Zoom room is due for a reminder like a Meet", () => {
  const l = bookedMeet({ meetUrl: null, roomUrl: ROOM });
  assert.deepEqual(dueReminders(l, START - 5 * MIN, 10).map((r) => r.id), ["r_1"]);
});

test("meetUrl is refused on a meeting that is not a Meet", () => {
  for (const format of ["in_person", "phone", "unknown"]) {
    const l = addRequest(empty(), input({ format }), T0, "r_1");
    assert.throws(() => updateRequest(l, "r_1", { meetUrl: MEET }, T0), /meetUrl/, format);
  }
  // Setting both in one patch is fine.
  const l = addRequest(empty(), input(), T0, "r_1");
  assert.equal(updateRequest(l, "r_1", { format: "meet", meetUrl: MEET }, T0).requests[0]!.meetUrl, MEET);
});

test("moving a Meet to another format drops its link", () => {
  const l = updateRequest(bookedMeet(), "r_1", { format: "in_person", location: "Office" }, T0);
  assert.equal(l.requests[0]!.format, "in_person");
  assert.equal("meetUrl" in l.requests[0]!, false);
});

test("booked needs valid times in order and an account", () => {
  const l = addRequest(empty(), input(), T0, "r_1");
  for (const bad of [
    { ...booked, start: "soon" },
    { ...booked, end: booked.start },
    { ...booked, end: "2026-10-01T14:00:00-03:00" },
    { ...booked, account: "" },
    { start: booked.start, end: booked.end },
  ]) {
    assert.throws(() => updateRequest(l, "r_1", { booked: bad } as never, T0), /booked/, JSON.stringify(bad));
  }
});

test("reminder needs a valid time and a known outcome", () => {
  const l = bookedMeet();
  const at = new Date(T0).toISOString();
  for (const outcome of ["sent", "cancelled", "no-link"]) {
    assert.equal(updateRequest(l, "r_1", { reminder: { at, outcome } } as never, T0).requests[0]!.reminder!.outcome, outcome);
  }
  assert.throws(() => updateRequest(l, "r_1", { reminder: { at: "now", outcome: "sent" } }, T0), /reminder/);
  assert.throws(() => updateRequest(l, "r_1", { reminder: { at, outcome: "maybe" } } as never, T0), /reminder/);
});

test("null clears booked, meetUrl and reminder", () => {
  let l = bookedMeet({ reminder: { at: new Date(T0).toISOString(), outcome: "sent" } });
  l = updateRequest(l, "r_1", { booked: null, meetUrl: null, reminder: null }, T0);
  for (const key of ["booked", "meetUrl", "reminder"]) assert.equal(key in l.requests[0]!, false, key);
});

test("a reminder is due from ten minutes before the start to five after", () => {
  const l = bookedMeet();
  const due = (ms: number) => dueReminders(l, ms, 10).map((r) => r.id);
  assert.deepEqual(due(START - 10 * MIN - 1), []);
  assert.deepEqual(due(START - 10 * MIN), ["r_1"]);
  assert.deepEqual(due(START - 1 * MIN), ["r_1"]);
  assert.deepEqual(due(START), ["r_1"]);
  assert.deepEqual(due(START + 5 * MIN - 1), ["r_1"]);
  assert.deepEqual(due(START + 5 * MIN), []);
  assert.deepEqual(due(START + 60 * MIN), []);
});

test("the lead and the grace are parameters", () => {
  const l = bookedMeet();
  assert.deepEqual(dueReminders(l, START - 30 * MIN, 30).map((r) => r.id), ["r_1"]);
  assert.deepEqual(dueReminders(l, START + 9 * MIN, 10, 10).map((r) => r.id), ["r_1"]);
  assert.deepEqual(dueReminders(l, START + 9 * MIN, 10, 0).map((r) => r.id), []);
});

test("only a booked meeting with an event, a time and no reminder yet is due", () => {
  const at = START - 5 * MIN;
  const cases: [string, Ledger][] = [
    ["already sent", bookedMeet({ reminder: { at: new Date(T0).toISOString(), outcome: "sent" } })],
    ["cancelled", bookedMeet({ reminder: { at: new Date(T0).toISOString(), outcome: "cancelled" } })],
    ["no booked time", bookedMeet({ booked: null })],
    ["dropped", bookedMeet({ status: "dropped" })],
    ["still offered", bookedMeet({ status: "offered" })],
  ];
  for (const [name, l] of cases) assert.deepEqual(dueReminders(l, at, 10), [], name);
  assert.equal(dueReminders(bookedMeet(), at, 10).length, 1);
  // Any format is re-read in the window, so an external cancellation is seen; only a Meet gets a reminder.
  assert.equal(dueReminders(bookedMeet({ format: "in_person", meetUrl: null }), at, 10).length, 1);
});

test("several meetings: each is due on its own time", () => {
  let l = bookedMeet();
  l = addRequest(l, input({ handle: "+15559999999", format: "meet" }), T0, "r_2");
  const later = { ...booked, start: "2026-10-01T17:00:00-03:00", end: "2026-10-01T17:30:00-03:00" };
  l = updateRequest(l, "r_2", { status: "booked", eventId: "e2", booked: later, meetUrl: "https://meet.google.com/zzz-yyyy-xxx" }, T0);
  assert.deepEqual(dueReminders(l, START - 5 * MIN, 10).map((r) => r.id), ["r_1"]);
  assert.deepEqual(dueReminders(l, Date.parse(later.start) - 5 * MIN, 10).map((r) => r.id), ["r_2"]);
});

test("the reminder lead reads MEETLY_REMINDER_LEAD_MIN and falls back to 10", () => {
  const saved = process.env.MEETLY_REMINDER_LEAD_MIN;
  try {
    for (const [value, expected] of [[undefined, 10], ["15", 15], ["abc", 10], ["0", 10], ["-5", 10], ["", 10]] as const) {
      if (value === undefined) delete process.env.MEETLY_REMINDER_LEAD_MIN;
      else process.env.MEETLY_REMINDER_LEAD_MIN = value;
      assert.equal(reminderLeadMin(), expected, String(value));
    }
  } finally {
    if (saved === undefined) delete process.env.MEETLY_REMINDER_LEAD_MIN;
    else process.env.MEETLY_REMINDER_LEAD_MIN = saved;
  }
});

test("CLI save with a format, book, list due reminders, mark sent", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ format: "meet", locale: "pt-BR" }))], env);
  assert.equal(saved.status, 0, saved.stderr);
  const id = saved.json.request.id;
  assert.equal(saved.json.request.format, "meet");
  // The CLI reads the real clock: book a meeting one day from now.
  const start = Date.now() + 24 * 60 * MIN;
  const tomorrow = { start: new Date(start).toISOString(), end: new Date(start + 30 * MIN).toISOString(), account: "owner@example.com" };
  const patch = { status: "booked", eventId: "e1", booked: tomorrow, meetUrl: MEET };
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify(patch)], env).status, 0);
  assert.deepEqual(cli("ledger.ts", ["reminders"], env).json, { requests: [] });
  const due = cli("ledger.ts", ["reminders", "--lead-min", String(25 * 60)], env);
  assert.equal(due.status, 0, due.stderr);
  assert.deepEqual(due.json.requests.map((r: { id: string }) => r.id), [id]);
  // The env var sets the default lead.
  assert.equal(cli("ledger.ts", ["reminders"], { ...env, MEETLY_REMINDER_LEAD_MIN: String(25 * 60) }).json.requests.length, 1);
  const mark = { reminder: { at: new Date().toISOString(), outcome: "sent" } };
  cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify(mark)], env);
  assert.deepEqual(cli("ledger.ts", ["reminders", "--lead-min", String(25 * 60)], env).json, { requests: [] });
  const bad = cli("ledger.ts", ["reminders", "--lead-min", "x"], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /lead-min/);
  const url = cli("ledger.ts", ["update", "--id", id, "--json", '{"meetUrl":"https://evil.example/x"}'], env);
  assert.equal(url.status, 1);
  assert.match(url.stderr, /meetUrl/);
});
