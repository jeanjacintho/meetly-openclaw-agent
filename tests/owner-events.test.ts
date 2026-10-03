import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { listOwnerEvents, ownerEvents } from "../skills/meetly/scripts/owner-events.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, macBridge, tmpHome, type MacCall as Call } from "./helpers.ts";

const TZ = "America/Sao_Paulo";
const range = { from: "2026-10-01T00:00:00-03:00", to: "2026-10-02T00:00:00-03:00" };

// What plow-gog prints for one account: the whole event, attendees' emails included.
const gog = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, summary, CalendarID: "owner@example.com", startLocal: start, endLocal: end, start: { dateTime: start }, end: { dateTime: end },
  status: "confirmed", attendees: [{ email: "ana@example.com", responseStatus: "accepted" }], organizer: { email: "boss@example.com" },
  description: "dial-in 1234", location: "Room 4", ...extra,
});

test("the model sees an event's title, id, account and times, and nothing else", () => {
  const events = [
    { ...gog("e1", "Almoço com Amor", "2026-10-01T12:30:00-03:00", "2026-10-01T13:00:00-03:00"), account: "owner@example.com" },
    { ...gog("e2", "Holiday", "2026-10-01", "2026-10-02", { allDay: true }), account: "work@example.com" },
    { ...gog("e3", "Gone", "2026-10-01T09:00:00-03:00", "2026-10-01T10:00:00-03:00", { status: "cancelled" }), account: "owner@example.com" },
    { id: "e4", account: "owner@example.com", start: { dateTime: "2026-10-01T15:00:00-03:00" }, end: { dateTime: "2026-10-01T16:00:00-03:00" } },
  ];
  assert.deepEqual(ownerEvents(events), [
    { id: "e1", account: "owner@example.com", calendarId: "owner@example.com", title: "Almoço com Amor", start: "2026-10-01T12:30:00-03:00", end: "2026-10-01T13:00:00-03:00" },
    { id: "e2", account: "work@example.com", calendarId: "owner@example.com", title: "Holiday", start: "2026-10-01", end: "2026-10-02" },
    { id: "e4", account: "owner@example.com", calendarId: "primary", title: "(no title)", start: "2026-10-01T15:00:00-03:00", end: "2026-10-01T16:00:00-03:00" },
  ]);
  const text = JSON.stringify(ownerEvents(events));
  for (const leak of ["ana@example.com", "boss@example.com", "dial-in", "Room 4"]) assert.ok(!text.includes(leak), leak);
});

test("each configured account is read on the Mac, and every event keeps the account it came from", async () => {
  const calls: Call[] = [];
  const r = await listOwnerEvents({
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }, { account: "work@example.com", id: "work@example.com" }],
  }, range, { token: "tok", fetch: macBridge((argv) => JSON.stringify({ events: [gog(`id-${argv[argv.indexOf("--account") + 1]}`, "Sync", "2026-10-01T10:00:00-03:00", "2026-10-01T10:30:00-03:00")] }), calls) });
  assert.equal(calls.length, 2);
  assert.deepEqual(r.events.map((e) => [e.id, e.account]), [["id-owner@example.com", "owner@example.com"], ["id-work@example.com", "work@example.com"]]);
  assert.deepEqual(r.degraded, []);
  assert.ok(!JSON.stringify(r).includes("ana@example.com"));
});

test("an account the Mac could not read is degraded, never reported as empty", async () => {
  const r = await listOwnerEvents({ calendars: [{ account: "owner@example.com", id: "owner@example.com" }] }, range, { token: "" });
  assert.deepEqual(r, { events: [], degraded: ["owner@example.com"] });
});

test("an event from a secondary calendar keeps that calendar's id, so it is changed there and not on primary", async () => {
  const team = gog("t1", "Team sync", "2026-10-01T10:00:00-03:00", "2026-10-01T10:30:00-03:00", { CalendarID: "team@group.calendar.google.com" });
  const r = await listOwnerEvents({ calendars: [{ account: "owner@example.com", id: "team@group.calendar.google.com" }] }, range, { token: "tok", fetch: macBridge(() => JSON.stringify({ events: [team] })) });
  assert.deepEqual(r.events.map((e) => [e.id, e.account, e.calendarId]), [["t1", "owner@example.com", "team@group.calendar.google.com"]]);
});

test("partial listings degrade the account", async () => {
  const config = { calendars: [{ account: "owner@example.com", id: "owner@example.com" }] };
  const event = gog("e1", "Sync", "2026-10-01T10:00:00-03:00", "2026-10-01T10:30:00-03:00");
  const cases = [
    ["degraded metadata", { items: [event], degraded: ["team@group.calendar.google.com"] }, 1],
    ["server truncation", { events: [event], truncated: { omitted: 4, after: "2026-10-01T11:00:00-03:00" } }, 1],
    ["100-event cap", { events: Array.from({ length: 100 }, (_, i) => ({ ...event, id: `e${i}` })) }, 100],
  ] as const;
  for (const [name, listing, count] of cases) {
    const r = await listOwnerEvents(config, range, { token: "tok", fetch: macBridge(() => JSON.stringify(listing)) });
    assert.deepEqual([r.events.length, r.degraded], [count, ["owner@example.com"]], name);
  }
});

test("the CLI needs a range and a finished setup, and prints only the safe fields", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), {
    ownerName: "Ana", timezone: TZ, days: ["mon"], windowStart: "09:00", windowEnd: "17:00", durationMin: 30, horizonDays: 3,
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }], defaultAccount: "owner@example.com", setupDoneAt: "2026-09-26T00:00:00Z",
  });
  const env = { MEETLY_HOME: home, PLOW_MCP_BRIDGE_TOKEN: "" };
  assert.notEqual(cli("owner-events.ts", [], env).status, 0);
  const r = cli("owner-events.ts", ["--from", range.from, "--to", range.to], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { events: [], degraded: ["owner@example.com"] });
  assert.notEqual(cli("owner-events.ts", ["--from", range.from, "--to", range.to], { MEETLY_HOME: tmpHome() }).status, 0);
});
