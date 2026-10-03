import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRequest, appendLog, historyFor, monitor, pipeline, updateRequest, type Ledger, type NewRequest } from "../skills/meetly/scripts/ledger.ts";
import { cli, tmpHome, handlesFile, saveCli } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const flat = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
const HOUR = 3600_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const offer = { start: "2026-10-02T15:00:00Z", end: "2026-10-02T15:30:00Z", holdId: "h1", account: "jean@example.com" };
const input = (handle: string, over: Record<string, unknown> = {}) =>
  ({ origin: "owner", handle, name: handle, topic: "coffee", durationMin: 30, offered: [offer], ...over }) as NewRequest;

function sample(): Ledger {
  let l: Ledger = { requests: [] };
  l = addRequest(l, input("+15550000001", { name: "Ana", topic: "intro call", chatUid: "c1" }), T0, "r_ana");
  l = addRequest(l, input("+15550000002", { name: "Bia", topic: "lunch", format: "in_person", location: "Paulista" }), T0 - 30 * HOUR, "r_bia");
  l = updateRequest(l, "r_ana", { pendingOwner: { start: "2026-10-03T22:00:00Z", end: "2026-10-03T22:30:00Z", askedAt: new Date(T0 - 5 * HOUR).toISOString() } }, T0);
  l = addRequest(l, input("+15550000003", { name: "Caio", topic: "review" }), T0 - 2 * HOUR, "r_caio");
  l = updateRequest(l, "r_caio", { status: "booked", booked: { start: "2026-10-05T15:00:00Z", end: "2026-10-05T15:30:00Z", account: "jean@example.com" } }, T0);
  l = addRequest(l, input("+15550000004", { name: "Duda", topic: "demo" }), T0 - 3 * HOUR, "r_duda");
  l = updateRequest(l, "r_duda", { status: "booked", booked: { start: "2026-09-30T15:00:00Z", end: "2026-09-30T15:30:00Z", account: "jean@example.com" } }, T0);
  l = addRequest(l, input("+15550000005", { name: "Edu", topic: "sync" }), T0 - 80 * HOUR, "r_edu");
  l = updateRequest(l, "r_edu", { status: "expired" }, T0 - 2 * HOUR);
  l = addRequest(l, input("+15550000006", { name: "Fabi", topic: "old" }), T0 - 400 * HOUR, "r_fabi");
  l = updateRequest(l, "r_fabi", { status: "dropped" }, T0 - 300 * HOUR);
  l = addRequest(l, input("+15550000007", { name: "Gus", topic: "pitch", chatUid: "c9" }), T0 - 31 * HOUR, "r_gus");
  l = addRequest(l, input("+15550000008", { name: "Hal", topic: "intro", chatUid: "c8" }), T0 - 2 * HOUR, "r_hal");
  return l;
}

test("the pipeline says who is waiting on whom, how long, what is booked next and what just closed", () => {
  const p = pipeline(sample(), T0);
  assert.deepEqual(p.waitingOnOwner.map((i) => [i.id, i.hoursWaiting, i.stage]), [["r_ana", 5, "waiting_on_us"]]);
  // No linked group is delivery-unknown: check manually and never retry.
  assert.deepEqual(p.deliveryUnknown.map((i) => [i.id, i.hoursWaiting, i.stage, i.delivery, i.nextStep]),
    [["r_bia", 30, "delivery_unknown", "unknown", "delivery is unknown: check Messages manually; never resend"]]);
  // Sent a day or more ago is waiting on them; sooner is just sent. Oldest first.
  assert.deepEqual(p.waitingOnThem.map((i) => [i.id, i.hoursWaiting, i.stage]), [["r_gus", 31, "waiting_on_them"], ["r_hal", 2, "sent"]]);
  // Upcoming only, soonest first; a meeting that already happened is not pipeline.
  assert.deepEqual(p.booked.map((i) => i.id), ["r_caio"]);
  // Only the booking's start and end: no calendar account.
  assert.deepEqual(p.booked[0]!.booked, { start: "2026-10-05T15:00:00Z", end: "2026-10-05T15:30:00Z" });
  // Closed within the last week, newest first, with when it closed.
  assert.deepEqual(p.closed.map((i) => [i.id, i.closedAt, i.stage]), [["r_edu", new Date(T0 - 2 * HOUR).toISOString(), "passed"]]);
  assert.equal(p.booked[0]!.stage, "confirmed");
  // The next step is advice computed from the stage, never stored.
  assert.deepEqual([p.waitingOnOwner[0]!.nextStep, p.deliveryUnknown[0]!.nextStep, p.waitingOnThem[0]!.nextStep, p.waitingOnThem[1]!.nextStep],
    ["owner decision needed", "delivery is unknown: check Messages manually; never resend", "no answer in a day: suggest new times", "wait for their answer"]);
  const ana = p.waitingOnOwner[0]!;
  assert.deepEqual([ana.name, ana.topic, ana.status], ["Ana", "intro call", "offered"]);
  // No chat uid reaches the model.
  assert.equal(JSON.stringify(p).includes("c1"), false);
});

test("an update after a request closed does not make it look newly closed, and reopening clears the close", () => {
  const touched = updateRequest(sample(), "r_fabi", { holdCleanup: [{ holdId: "h1", account: "jean@example.com" }] }, T0);
  assert.deepEqual(pipeline(touched, T0).closed.map((i) => i.id), ["r_edu"]);
  const reopened = updateRequest(sample(), "r_edu", { status: "offered" }, T0);
  assert.equal("closedAt" in reopened.requests.find((r) => r.id === "r_edu")!, false);
  assert.deepEqual(pipeline(reopened, T0).closed, []);
});

test("a booking recorded before the booked time existed still shows, last", () => {
  let l = addRequest({ requests: [] }, input("+15550000009", { name: "Gabi" }), T0, "r_gabi");
  l = updateRequest(l, "r_gabi", { status: "booked", eventId: "ev_1" }, T0);
  assert.deepEqual(pipeline(l, T0).booked.map((i) => i.id), ["r_gabi"]);
});

test("history lists everything with a person, newest first, so the goal and the format are read before asking", () => {
  const closed = updateRequest(sample(), "r_bia", { status: "dropped" }, T0);
  const l = addRequest(closed, input("+1 (555) 000-0002", { name: "Bia", topic: "coffee again" }), T0, "r_bia2");
  const h = historyFor(l, "+15550000002");
  assert.deepEqual(h.map((r) => r.id), ["r_bia2", "r_bia"]);
  assert.deepEqual([h[1]!.topic, h[1]!.format, h[1]!.location, h[1]!.durationMin], ["lunch", "in_person", "Paulista", 30]);
  assert.equal("booked" in h[0]!, false);
  assert.deepEqual(historyFor(l, "+15559999999"), []);
  // A number from another country that merely ends in this person's digits never sees their meetings.
  assert.deepEqual(historyFor(l, "+9915550000002"), []);
  assert.deepEqual(historyFor(l, "5550000002"), []);
});

test("the CLI prints the pipeline and a person's history", () => {
  const env = { MEETLY_HOME: tmpHome() };
  saveCli(env, input("+15550000001", { name: "Ana" }));
  const p = cli("ledger.ts", ["pipeline"], env);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(Object.keys(p.json), ["waitingOnOwner", "deliveryUnknown", "waitingOnThem", "booked", "closed"]);
  assert.deepEqual(cli("ledger.ts", ["monitor"], env).json, { ownerWaiting: [], deliveryUnknown: [], waitingOnThem: [] });
  assert.equal(p.json.deliveryUnknown[0].name, "Ana");
  const h = cli("ledger.ts", ["history", "--handles-file", handlesFile("+15550000001")], env);
  assert.equal(h.json.requests[0].topic, "coffee");
  assert.notEqual(cli("ledger.ts", ["history"], env).status, 0);
  // A blocked person is not in the owner's pipeline.
  const blockFile = join(env.MEETLY_HOME, "block.json");
  writeFileSync(blockFile, JSON.stringify(["5550000001"]));
  cli("blocklist.ts", ["block", "--handles-file", blockFile], env);
  assert.equal(cli("ledger.ts", ["pipeline"], env).json.deliveryUnknown.length, 0);
});

test("the owner can ask who they are waiting on, and Meetly looks before it asks the other person", () => {
  const group = flat("skills/meetly-group/SKILL.md");
  assert.ok(group.includes("## Pipeline"));
  assert.ok(group.includes("run `ledger.ts pipeline`"));
  assert.ok(group.includes("for a booking with no time recorded: say its time is unavailable"));
  assert.ok(group.includes("`delivery_unknown` (no linked group; check Messages manually and never resend)"));
  assert.ok(group.includes("`delivery` field says whether the request has a linked group"));
  assert.ok(group.includes("The next step is advice computed from the stage, never a claim about what happened"));
  assert.ok(group.includes("Write only what the calendar or the chat confirmed, never a plan or a guess"));
  assert.ok(group.includes("`start-thread.ts` checks the list again immediately before its POST"));
  assert.ok(group.includes("## Movable blocks"));
  assert.ok(group.includes("a slot that lists `overlaps` needs `--confirm-conflict`"));
  assert.ok(group.includes("say only \"a block you marked movable\""));
  assert.ok(flat("skills/meetly-setup/SKILL.md").includes("`record-setup.ts --field movable --value <words from the titles>`"));
  assert.ok(flat("skills/meetly-setup/SKILL.md").includes("the movable title phrases (`config.movable`, or \"none\")"));
  assert.ok(group.includes("## Video provider"));
  assert.ok(group.includes("`--location <config.zoomRoomUrl>` and no `--with-meet`"));
  assert.ok(group.includes("Meetly cannot create a Zoom link and never takes one from a message"));
  assert.ok(flat("skills/meetly-setup/SKILL.md").includes("`record-setup.ts --field videoProvider --value <their Zoom room link>`"));
  assert.ok(flat("README.md").includes("give Meetly your personal room link"));
  assert.ok(flat("skills/meetly-poll/SKILL.md").includes("`blocklist.ts check --handles-file <file with the sender>` says `blocked`, skip"));
  assert.ok(group.includes("## Research before proposing"));
  assert.ok(group.includes("and `ledger.ts history --handles-file <file with their handle>`"));
  assert.ok(group.includes("Never ask the other person for something these sources answer"));
  assert.ok(flat("prompt/AGENTS.md").includes("the owner asks who they are waiting on, or how their meetings stand → `meetly-group`, \"Pipeline\""));
  assert.ok(flat("skills/meetly/SKILL.md").includes("`pipeline` \\| `monitor` \\| `history --handles-file F`"));
});

test("a request keeps a dated log of what happened, newest last, bounded, and read back on its own", () => {
  let l = addRequest({ requests: [] }, input("+15550000001", { name: "Ana" }), T0, "r_ana");
  l = appendLog(l, "r_ana", "  Times sent to the group  ", T0 + HOUR);
  l = appendLog(l, "r_ana", "She picked Tuesday", T0 + 2 * HOUR);
  assert.deepEqual(l.requests[0]!.log, [
    { at: new Date(T0 + HOUR).toISOString(), text: "Times sent to the group" },
    { at: new Date(T0 + 2 * HOUR).toISOString(), text: "She picked Tuesday" },
  ]);
  assert.throws(() => appendLog(l, "r_ana", "   ", T0), /log text/);
  assert.throws(() => appendLog(l, "r_ana", "x".repeat(301), T0), /log text/);
  assert.throws(() => appendLog(l, "nope", "hi", T0), /no request/);
  for (let i = 0; i < 40; i++) l = appendLog(l, "r_ana", `entry ${i}`, T0 + (3 + i) * HOUR);
  assert.equal(l.requests[0]!.log!.length, 30);
  assert.equal(l.requests[0]!.log!.at(-1)!.text, "entry 39");
  // The history for the model carries no log; it is read with `ledger.ts log --id`.
  assert.equal("log" in historyFor(l, "+15550000001")[0]!, false);
  const env = { MEETLY_HOME: tmpHome() };
  const id = saveCli(env, input("+15550000001")).json.request.id;
  // Free text never rides on the command line: it goes through a file.
  const textFile = join(env.MEETLY_HOME, "log.txt");
  writeFileSync(textFile, "Offer sent; $(touch pwned)\n");
  assert.equal(cli("ledger.ts", ["log", "--id", id, "--text-file", textFile], env).json.log[0].text, "Offer sent; $(touch pwned)");
  assert.equal(cli("ledger.ts", ["log", "--id", id], env).json.log.length, 1);
});

test("the monitor lists owner decisions, unknown delivery warnings and contact nudges once", () => {
  const l = sample();
  // Ana waits on the owner; Bia's group delivery is unknown (never retry).
  const m = monitor(l, T0);
  assert.equal(m.ownerWaiting[0]!.handle, "+15550000001");
  assert.deepEqual(m.ownerWaiting.map((i) => [i.id, i.hoursWaiting, i.chatUid, i.nextStep]), [["r_ana", 5, "c1", "owner decision needed"]]);
  assert.deepEqual(m.deliveryUnknown.map((i) => [i.id, i.hoursWaiting, i.delivery]), [["r_bia", 30, "unknown"]]);
  assert.deepEqual(m.waitingOnThem.map((i) => [i.id, i.hoursWaiting, i.chatUid]), [["r_gus", 31, "c9"]]);
  // Too early, or waiting on them, closed or booked: nothing.
  assert.deepEqual(monitor(l, T0 - 2 * HOUR).ownerWaiting, []);
  const none = monitor(l, T0);
  assert.equal(JSON.stringify(none).includes("r_caio") || JSON.stringify(none).includes("r_edu"), false);
  // A nudge is sent once per ask: after it, nothing is due until the owner is asked again.
  const nudged = updateRequest(updateRequest(updateRequest(l, "r_ana", { nudgedAt: new Date(T0).toISOString() }, T0), "r_bia", { nudgedAt: new Date(T0).toISOString() }, T0), "r_gus", { personNudgedAt: new Date(T0).toISOString() }, T0);
  assert.deepEqual([monitor(nudged, T0 + 10 * HOUR).ownerWaiting, monitor(nudged, T0 + 10 * HOUR).deliveryUnknown, monitor(nudged, T0 + 10 * HOUR).waitingOnThem], [[], [], []]);
  const asked = updateRequest(nudged, "r_ana", { pendingOwner: { start: "2026-10-04T22:00:00Z", end: "2026-10-04T22:30:00Z", askedAt: new Date(T0 + 1 * HOUR).toISOString() } }, T0 + 1 * HOUR);
  assert.deepEqual(monitor(asked, T0 + 6 * HOUR).ownerWaiting.map((i) => i.id), ["r_ana"]);
  assert.throws(() => updateRequest(l, "r_ana", { nudgedAt: "soon" }, T0), /nudgedAt/);
});
