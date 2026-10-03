import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMeetUrl, parseEvent } from "../skills/meetly/scripts/event.ts";
import { cli, tmpHome } from "./helpers.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures", "calendar");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
// The JSON part of a fixture, without gog's leading "Note:" line.
const body = (name: string) => JSON.parse(fixture(name).slice(fixture(name).indexOf("{")));

test("a Meet URL is only https://meet.google.com/xxx-xxxx-xxx", () => {
  assert.ok(isMeetUrl("https://meet.google.com/sai-nvgi-cdg"));
  for (const bad of [
    "http://meet.google.com/sai-nvgi-cdg",
    "https://meet.google.com.evil.example/sai-nvgi-cdg",
    "https://evil.example/https://meet.google.com/sai-nvgi-cdg",
    "https://meet.google.com/sai-nvgi-cdg?authuser=1",
    "https://meet.google.com/sai-nvgi-cdg/",
    "https://meet.google.com/SAI-NVGI-CDG",
    "https://meet.google.com/sai-nvg-cdg",
    "https://meet.google.com/lookup/abc",
    "https://zoom.us/j/123456789",
    " https://meet.google.com/sai-nvgi-cdg",
    "https://meet.google.com/sai-nvgi-cdg\nhttps://evil.example",
    "",
    undefined,
    null,
    42,
  ]) {
    assert.equal(isMeetUrl(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a booked event with Meet: id, status, times and link, past gog's Note line", () => {
  assert.deepEqual(parseEvent(fixture("event-meet")), {
    id: "evt123abc",
    status: "confirmed",
    start: "2026-10-10T04:00:00-03:00",
    end: "2026-10-10T04:30:00-03:00",
    meetUrl: "https://meet.google.com/sai-nvgi-cdg",
    roomUrl: null,
  });
});

test("an event without a conference has no link", () => {
  assert.equal(parseEvent(fixture("event-plain")).meetUrl, null);
});

test("a deleted event reads back as cancelled", () => {
  assert.equal(parseEvent(fixture("event-cancelled")).status, "cancelled");
});

test("the link falls back to the video entry point when hangoutLink is missing", () => {
  const b = body("event-meet");
  delete b.event.hangoutLink;
  assert.equal(parseEvent(JSON.stringify(b)).meetUrl, "https://meet.google.com/sai-nvgi-cdg");
  b.event.conferenceData.entryPoints = [
    { entryPointType: "phone", uri: "tel:+1-555-0100" },
    { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
  ];
  assert.equal(parseEvent(JSON.stringify(b)).meetUrl, "https://meet.google.com/abc-defg-hij");
});

test("a link that is not a Meet URL is never returned", () => {
  const b = body("event-meet");
  b.event.hangoutLink = "https://evil.example/join";
  b.event.conferenceData.entryPoints = [{ entryPointType: "video", uri: "https://evil.example/join" }];
  assert.equal(parseEvent(JSON.stringify(b)).meetUrl, null);
  // A bad hangoutLink does not hide a good entry point.
  b.event.conferenceData.entryPoints = [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }];
  assert.equal(parseEvent(JSON.stringify(b)).meetUrl, "https://meet.google.com/abc-defg-hij");
});

test("a Zoom conference is not a Meet link", () => {
  const b = body("event-plain");
  b.event.conferenceData = { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123456789" }] };
  assert.equal(parseEvent(JSON.stringify(b)).meetUrl, null);
});

test("only a strictly valid Zoom room in the event location is taken as the room", () => {
  const withLocation = (location: unknown) => { const b = body("event-plain"); b.event.location = location; return parseEvent(JSON.stringify(b)).roomUrl; };
  assert.equal(withLocation("https://zoom.us/j/123456789?pwd=abc.DEF"), "https://zoom.us/j/123456789?pwd=abc.DEF");
  for (const bad of ["http://zoom.us/j/1", "https://zoom.us.evil.example/j/1", "https://zoom.us/j/1?x=1", "Starbucks", "", 5, null]) assert.equal(withLocation(bad), null, String(bad));
  assert.equal(parseEvent(fixture("event-plain")).roomUrl, null);
});

test("a bare event object and the whole plow_run_command result both parse", () => {
  assert.equal(parseEvent(JSON.stringify(body("event-meet").event)).id, "evt123abc");
  const envelope = { exit_code: 0, handle: "H", output: fixture("event-meet"), status: "completed" };
  assert.equal(parseEvent(JSON.stringify(envelope)).meetUrl, "https://meet.google.com/sai-nvgi-cdg");
});

test("a missing status reads as confirmed", () => {
  const b = body("event-meet");
  delete b.event.status;
  assert.equal(parseEvent(JSON.stringify(b)).status, "confirmed");
});

test("anything that is not one timed event is refused", () => {
  const b = body("event-meet");
  const allDay = structuredClone(b);
  allDay.event.start = { date: "2026-10-10" };
  allDay.event.end = { date: "2026-10-11" };
  const noId = structuredClone(b);
  delete noId.event.id;
  const badTime = structuredClone(b);
  badTime.event.start.dateTime = "soon";
  const backwards = structuredClone(b);
  backwards.event.end.dateTime = "2026-10-10T03:00:00-03:00";
  const oddStatus = structuredClone(b);
  oddStatus.event.status = "maybe";
  const failed = { exit_code: 2, output: "refusing to delete event x without --force (non-interactive)\n" };
  for (const [name, text] of [
    ["empty", ""],
    ["no JSON", "Note: Using direct access token\n"],
    ["broken JSON", "{\"event\":"],
    ["a list", "[]"],
    ["an events listing", JSON.stringify({ events: [b.event] })],
    ["all-day", JSON.stringify(allDay)],
    ["no id", JSON.stringify(noId)],
    ["bad time", JSON.stringify(badTime)],
    ["end before start", JSON.stringify(backwards)],
    ["unknown status", JSON.stringify(oddStatus)],
    ["a failed command", JSON.stringify(failed)],
  ] as const) {
    assert.throws(() => parseEvent(text), Error, name);
  }
});

test("CLI prints the parsed event, or an error line", () => {
  const home = tmpHome();
  const ok = join(home, "e.txt");
  writeFileSync(ok, fixture("event-meet"));
  const r = cli("event.ts", ["--in", ok], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.meetUrl, "https://meet.google.com/sai-nvgi-cdg");
  const bad = join(home, "bad.txt");
  writeFileSync(bad, "nope");
  const f = cli("event.ts", ["--in", bad], {});
  assert.equal(f.status, 1);
  assert.match(f.stderr, /^error: /);
  assert.equal(cli("event.ts", [], {}).status, 1);
});
