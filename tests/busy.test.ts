import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBusy, instant, toBusy } from "../skills/meetly/scripts/busy.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, macBridge, tmpHome, type MacCall as Call } from "./helpers.ts";

const TZ = "America/Sao_Paulo";
const FIX = join(import.meta.dirname, "fixtures", "calendar");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const opts = { tz: TZ, max: 100 };

test("instant reads dates as local midnight and rejects junk", () => {
  assert.equal(new Date(instant("2026-09-30", TZ)).toISOString(), "2026-09-30T03:00:00.000Z");
  assert.equal(new Date(instant("2026-09-28T10:00:00-03:00", TZ)).toISOString(), "2026-09-28T13:00:00.000Z");
  assert.throws(() => instant("tomorrow", TZ));
});

test("fan-out: transparent and declined are skipped, all-day covers the local day", () => {
  const r = toBusy([fixture("fanout.json")], opts);
  assert.deepEqual(r, {
    busy: [
      { start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T13:30:00.000Z", id: "ev1", account: "owner@example.com" },
      { start: "2026-09-29T12:00:00.000Z", end: "2026-09-29T13:00:00.000Z", id: "ev6", account: "work@example.com" },
      { start: "2026-09-30T03:00:00.000Z", end: "2026-10-01T03:00:00.000Z", id: "ev4", account: "owner@example.com" },
    ],
    degraded: [],
  });
});

test("the raw Google shape: cancelled and self-declined are skipped", () => {
  const r = toBusy([fixture("single.json")], opts);
  assert.deepEqual(r.busy.map((b) => b.id), ["g1", "g4"]);
  assert.deepEqual(r.busy[0], { start: "2026-09-29T15:00:00.000Z", end: "2026-09-29T16:00:00.000Z", id: "g1" });
});

test("a multi-day all-day event blocks every day it spans", () => {
  const r = toBusy([fixture("single.json")], opts);
  const vacation = r.busy.find((b) => b.id === "g4")!;
  assert.equal(vacation.start, "2026-10-05T03:00:00.000Z");
  assert.equal(vacation.end, "2026-10-08T03:00:00.000Z");
  const multi = toBusy([[{ id: "v", startLocal: "2026-10-05", endLocal: "2026-10-10", allDay: true }]], opts);
  assert.deepEqual(multi.busy, [{ start: "2026-10-05T03:00:00.000Z", end: "2026-10-10T03:00:00.000Z", id: "v" }]);
});

test("truncated.after sets unknownAfter, earliest wins", () => {
  const a = toBusy([{ items: [], truncated: { omitted: 4, after: "2026-10-02" } }], opts);
  assert.equal(a.unknownAfter, "2026-10-02T03:00:00.000Z");
  const b = toBusy([
    { items: [], truncated: { omitted: 1, after: "2026-10-03T12:00:00-03:00" } },
    { items: [], truncated: { omitted: 1, after: "2026-10-01T09:00:00-03:00" } },
  ], opts);
  assert.equal(b.unknownAfter, "2026-10-01T12:00:00.000Z");
});

test("an account at max items: unknown after its last start", () => {
  const items = [
    { id: "1", startLocal: "2026-09-28T10:00:00-03:00", endLocal: "2026-09-28T11:00:00-03:00", account: "a" },
    { id: "2", startLocal: "2026-09-29T10:00:00-03:00", endLocal: "2026-09-29T11:00:00-03:00", account: "a" },
    { id: "3", startLocal: "2026-09-28T12:00:00-03:00", endLocal: "2026-09-28T13:00:00-03:00", account: "b" },
  ];
  const r = toBusy([{ items }], { tz: TZ, max: 2 });
  assert.equal(r.unknownAfter, "2026-09-29T13:00:00.000Z");
  assert.equal(toBusy([{ items }], { tz: TZ, max: 3 }).unknownAfter, undefined);
  const single = toBusy([{ events: [items[0], items[1]].map(({ account: _a, ...e }) => e) }], { tz: TZ, max: 2 });
  assert.equal(single.unknownAfter, "2026-09-29T13:00:00.000Z");
});

test("degraded accounts are reported as strings", () => {
  const r = toBusy([{ items: [], degraded: ["a@example.com", { account: "b@example.com", error: "401" }, { error: "x" }] }], opts);
  assert.deepEqual(r.degraded, ["a@example.com", "b@example.com", '{"error":"x"}']);
});

test("the CLI merges several files using the configured zone", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { timezone: TZ, setupDoneAt: "2026-09-26T00:00:00Z" });
  const r = cli("busy.ts", ["--in", join(FIX, "fanout.json"), "--in", join(FIX, "single.json")], { MEETLY_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.busy.map((b: { id: string }) => b.id), ["ev1", "ev6", "g1", "ev4", "g4"]);
  const stdin = cli("busy.ts", [], { MEETLY_HOME: home }, readFileSync(join(FIX, "single.json"), "utf8"));
  assert.equal(stdin.json.busy.length, 2);
  const noSetup = cli("busy.ts", ["--in", join(FIX, "fanout.json")], { MEETLY_HOME: tmpHome() });
  assert.equal(noSetup.status, 1);
});


const range = { from: "2026-09-30T13:36:05-03:00", to: "2026-10-04T13:36:05-03:00" };
const gogEvent = (id: string, start: string, end: string) =>
  ({ id, CalendarID: "owner@example.com", start: { dateTime: start }, end: { dateTime: end }, startLocal: start, endLocal: end, status: "confirmed" });

test("fetchBusy reads each account on the Mac itself, so no calendar JSON passes through the model", async () => {
  const calls: Call[] = [];
  const listing = JSON.stringify({ events: [gogEvent("e1", "2026-10-01T12:30:00-03:00", "2026-10-01T13:00:00-03:00")], nextPageTokens: [] }, null, 2);
  const r = await fetchBusy({
    timezone: TZ,
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }, { account: "owner@example.com", id: "team@group.calendar.google.com" }, { account: "work@example.com", id: "work@example.com" }],
  }, range, { token: "tok", fetch: macBridge(() => `Note: Using direct access token (expires in ~1 hour; no auto-refresh)\n${listing}\n`, calls) });
  assert.deepEqual(calls.map((c) => c.argv), [
    ["plow-gog", "calendar", "events", "--calendars", "owner@example.com,team@group.calendar.google.com", "--account", "owner@example.com", "--from", range.from, "--to", range.to, "--max", "100", "--json"],
    ["plow-gog", "calendar", "events", "--calendars", "work@example.com", "--account", "work@example.com", "--from", range.from, "--to", range.to, "--max", "100", "--json"],
  ]);
  assert.deepEqual(r.degraded, []);
  assert.deepEqual(r.busy.map((b) => [b.id, b.account, b.start]), [
    ["e1", "owner@example.com", "2026-10-01T15:30:00.000Z"],
    ["e1", "work@example.com", "2026-10-01T15:30:00.000Z"],
  ]);
});

test("fetchBusy reports an account it could not read as degraded, never as free", async () => {
  const r = await fetchBusy({
    timezone: TZ,
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }, { account: "work@example.com", id: "work@example.com" }],
  }, range, { token: "tok", fetch: macBridge((argv) => argv.includes("work@example.com") ? undefined : '{"events": []}') });
  assert.deepEqual(r, { busy: [], degraded: ["work@example.com"] });
  const noMac = await fetchBusy({ timezone: TZ, calendars: [{ account: "owner@example.com", id: "owner@example.com" }] }, range, { token: "" });
  assert.deepEqual(noMac.degraded, ["owner@example.com"]);
});

test("fetchBusy preserves the earliest server truncation as unknownAfter", async () => {
  const r = await fetchBusy({
    timezone: TZ,
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }, { account: "work@example.com", id: "work@example.com" }],
  }, range, { token: "tok", fetch: macBridge((argv) => argv.includes("work@example.com")
    ? JSON.stringify({ events: [], truncated: { after: "2026-10-02T12:00:00-03:00" } })
    : JSON.stringify({ events: [], truncated: { after: "2026-10-01T12:00:00-03:00" } })) });
  assert.deepEqual(r, { busy: [], degraded: [], unknownAfter: "2026-10-01T15:00:00.000Z" });
});

test("the CLI's --fetch writes tmp/busy.json for slots.ts and prints only a short summary", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), {
    ownerName: "Ana", timezone: TZ, days: ["mon"], windowStart: "09:00", windowEnd: "17:00", durationMin: 30, horizonDays: 3,
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }], defaultAccount: "owner@example.com", setupDoneAt: "2026-09-26T00:00:00Z",
  });
  const r = cli("busy.ts", ["--fetch"], { MEETLY_HOME: home, PLOW_MCP_BRIDGE_TOKEN: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { file: join(home, "tmp", "busy.json"), busy: 0, degraded: ["owner@example.com"] });
  assert.deepEqual(JSON.parse(readFileSync(join(home, "tmp", "busy.json"), "utf8")), { busy: [], degraded: ["owner@example.com"] });
});

test("a block whose title has an owner-listed word is marked movable, and no title leaves the script", () => {
  const items = [
    { id: "p1", account: "owner@example.com", summary: "Hold, prayer time", startLocal: "2026-09-28T07:00:00-03:00", endLocal: "2026-09-28T08:00:00-03:00" },
    { id: "m1", account: "owner@example.com", summary: "Board meeting", startLocal: "2026-09-28T09:00:00-03:00", endLocal: "2026-09-28T10:00:00-03:00" },
  ];
  const r = toBusy([{ items }], { tz: TZ, max: 100, movable: ["prayer"] });
  assert.deepEqual(r.busy.map((b) => [b.id, b.movable]), [["p1", true], ["m1", undefined]]);
  assert.equal(JSON.stringify(r).includes("prayer"), false);
  assert.equal(JSON.stringify(r).includes("Board"), false);
  assert.equal(toBusy([{ items }], opts).busy.some((b) => b.movable), false);
});
