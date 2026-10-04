import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRequest, approveRequest, declineRequest, assertDeliverable, saveRequest, settleOffer, discardStaleOffers, removeCleanupRef, appendLog, cleanupList, pendingOwnerList, ownerApprovalList, expiredRequests, expireRequests, monitor, findByChat, findByEvent, findOpenByHandle, normalizeHandle, sameHandle, updateRequest, pipeline, stageOf, commitTravel, reconcileTravel, dueReminders, setTravel, stageTravel,
  type Ledger, type NewRequest,
} from "../skills/meetly/scripts/ledger.ts";
import { cli, tmpHome, handlesFile, writeConfig, saveCli } from "./helpers.ts";

// The owner's yes to the times they saw: the request's current offer.
const yes = (l: Ledger, id: string, now: number) => approveRequest(l, id, now, l.requests.find((r) => r.id === id)?.offeredAt ?? "", true);
const T0 = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 3600_000;
const offer = { start: "2026-09-29T12:00:00-03:00", end: "2026-09-29T12:30:00-03:00", holdId: "h1", account: "jean@example.com" };
const input = (over: Record<string, unknown> = {}) => ({
  origin: "inbound", handle: "+15551234567", topic: "coffee", durationMin: 30, offered: [offer], ...over,
}) as NewRequest;
const empty = (): Ledger => ({ requests: [] });

test("handles normalize phones and emails", () => {
  assert.equal(normalizeHandle("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizeHandle("(555) 123-4567"), "5551234567");
  assert.equal(normalizeHandle(" Ana@Example.COM "), "ana@example.com");
  assert.ok(sameHandle("+1 (555) 123-4567", "5551234567"));
  assert.ok(sameHandle("+15551234567", "(555) 123-4567"));
  assert.ok(sameHandle("ANA@example.com", "ana@EXAMPLE.com"));
  assert.ok(!sameHandle("+15551234567", "+15551234568"));
  assert.ok(!sameHandle("4567", "+15551234567"));
  assert.ok(!sameHandle("ana@example.com", "+15551234567"));
});

test("the same person written three ways matches one request", () => {
  const l = addRequest(empty(), input({ handle: "+1 (555) 123-4567" }), T0, "r_1");
  for (const h of ["+15551234567", "5551234567", "(555) 123-4567"]) assert.equal(findOpenByHandle(l, h)?.id, "r_1");
  const e = addRequest(empty(), input({ handle: "Ana@Example.com" }), T0, "r_2");
  assert.equal(findOpenByHandle(e, "ana@example.com")?.id, "r_2");
});

test("add sets status and times, and validates", () => {
  const l = addRequest(empty(), input(), T0, "r_1");
  const r = l.requests[0]!;
  assert.equal(r.status, "offered");
  assert.equal(r.offeredAt, new Date(T0).toISOString());
  assert.equal(r.createdAt, r.updatedAt);
  assert.throws(() => addRequest(empty(), input({ origin: "email" }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ handle: "" }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ topic: " " }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ durationMin: 0 }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ offered: [] }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ offered: [{ ...offer, start: "soon" }] }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ offered: [{ ...offer, account: "" }] }), T0, "x"));
});

test("a second open request for the same person is refused until the first closes", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  assert.throws(() => addRequest(l, input({ handle: "5551234567", origin: "owner" }), T0, "r_2"), /open request r_1 already exists/);
  l = updateRequest(l, "r_1", { status: "booked", eventId: "e1" }, T0);
  l = addRequest(l, input(), T0, "r_2");
  assert.equal(findOpenByHandle(l, "+15551234567")?.id, "r_2");
});

test("save replaces a duplicate open offer by normalized handle and preserves its id", () => {
  const original = addRequest(empty(), input(), T0, "r_1");
  const updatedOffer = { ...offer, start: "2026-09-30T12:00:00-03:00", holdId: "h2" };
  const saved = saveRequest(original, input({ handle: "5551234567", offered: [updatedOffer] }), T0 + HOUR, "r_2");
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0]!.id, "r_1");
  assert.deepEqual(saved.requests[0]!.offered, [updatedOffer]);
  assert.deepEqual(saved.requests[0]!.holdCleanup, [{ holdId: "h1", account: offer.account }]);
  assert.equal(saved.requests[0]!.offeredAt, new Date(T0 + HOUR).toISOString());
  assert.equal(findOpenByHandle(saved, "+15551234567")!.id, "r_1");
});

test("an offer's travel blocks are holds: validated, and queued for deletion when the offer is replaced", () => {
  const travel = [{ holdId: "t1", account: "jean@example.com" }, { holdId: "t2", account: "jean@example.com" }];
  const withTravel = addRequest(empty(), input({ offered: [{ ...offer, travel }] }), T0, "r_1");
  assert.deepEqual(withTravel.requests[0]!.offered[0]!.travel, travel);
  for (const bad of [[{ holdId: "", account: "a" }], [{ holdId: "t1" }], "t1"]) {
    assert.throws(() => addRequest(empty(), input({ offered: [{ ...offer, travel: bad }] } as never), T0, "x"), /travel/);
  }
  // Replacing the offer moves the old slot's hold and both its travel blocks to cleanup, once.
  const replaced = saveRequest(withTravel, input({ offered: [{ ...offer, holdId: "h9", travel: [{ holdId: "t9", account: "jean@example.com" }] }] }), T0, "r_x");
  assert.deepEqual(replaced.requests[0]!.holdCleanup!.map((h) => h.holdId).sort(), ["h1", "t1", "t2"]);
  // A travel block kept in the new offer is not queued.
  const kept = saveRequest(withTravel, input({ offered: [{ ...offer, holdId: "h9", travel: [travel[0]!] }] }), T0, "r_y");
  assert.deepEqual(kept.requests[0]!.holdCleanup!.map((h) => h.holdId).sort(), ["h1", "t2"]);
});

test("moving a meeting: one move at a time, the new buffers out of cleanup's reach, ownership swapped only on commit", () => {
  const acct = "jean@example.com";
  const oldTravel = [{ holdId: "t1", account: acct }, { holdId: "t2", account: acct }];
  const newTravel = [{ holdId: "t3", account: acct }, { holdId: "t4", account: acct }];
  const target = { start: "2026-10-05T10:00:00-03:00", end: "2026-10-05T10:30:00-03:00" };
  let l = addRequest(empty(), input(), T0, "r_1");
  l = updateRequest(l, "r_1", { status: "booked", eventId: offer.holdId, booked: { start: offer.start, end: offer.end, account: acct, travel: oldTravel } }, T0);
  // Staged: the old buffers stay owned, the new ones are in neither the booking nor the cleanup queue.
  const staged = stageTravel(l, "r_1", newTravel, target, T0);
  assert.deepEqual(staged.requests[0]!.booked!.travel, oldTravel);
  assert.deepEqual(staged.requests[0]!.pendingTravel!.refs, newTravel);
  assert.equal(staged.requests[0]!.pendingTravel!.start, target.start);
  assert.deepEqual(cleanupList(staged), []);
  // A second move is refused while one is pending (the caller deletes the buffers it just made); nothing changes.
  assert.throws(() => stageTravel(staged, "r_1", [{ holdId: "t5", account: acct }], target, T0 + 60_000, "rev2"), /already has a move in progress/);
  // Committed: the new buffers are owned, the old ones queued, nothing pending.
  const done = commitTravel(staged, "r_1", "r_1", T0).ledger;
  assert.deepEqual(done.requests[0]!.booked!.travel, newTravel);
  // The booking takes the target interval in the same write (a dead turn before record-booking leaves nothing at the old time).
  assert.deepEqual([done.requests[0]!.booked!.start, done.requests[0]!.booked!.end], [target.start, target.end]);
  assert.deepEqual(done.requests[0]!.holdCleanup!.map((h) => h.holdId).sort(), ["t1", "t2"]);
  assert.equal(done.requests[0]!.pendingTravel, undefined);
  assert.equal(commitTravel(staged, "r_1", "other", T0).committed, false);
  // A turn that died before committing: nothing is touched until the stage is stale; then the live event decides.
  const early = { start: offer.start, end: offer.end };
  assert.deepEqual(reconcileTravel(staged, "r_1", early, T0 + 60_000), staged);
  const late = T0 + 20 * 60_000;
  // The calendar still shows the old time: the staged buffers are abandoned to cleanup.
  const abandoned = reconcileTravel(staged, "r_1", early, late).requests[0]!;
  assert.equal(abandoned.pendingTravel, undefined);
  assert.deepEqual(abandoned.booked!.travel, oldTravel);
  assert.deepEqual(abandoned.holdCleanup!.map((h) => h.holdId).sort(), ["t3", "t4"]);
  // A duration-only edit (same start, other end) is not the move the buffers were computed for: abandoned too.
  const resized = reconcileTravel(staged, "r_1", { start: target.start, end: "2026-10-05T11:00:00-03:00" }, late).requests[0]!;
  assert.deepEqual(resized.booked!.travel, oldTravel);
  assert.deepEqual(resized.holdCleanup!.map((h) => h.holdId).sort(), ["t3", "t4"]);
  // A reminder that belonged to the old start is cleared when the move lands.
  const reminded = updateRequest(staged, "r_1", { reminder: { at: new Date(T0).toISOString(), outcome: "sent" } }, T0);
  assert.equal(commitTravel(reminded, "r_1", "r_1", T0).ledger.requests[0]!.reminder, undefined);
  // The calendar accepted the move: the booking takes the new time and buffers, the old buffers are queued.
  const accepted = reconcileTravel(staged, "r_1", target, late).requests[0]!;
  assert.deepEqual([accepted.booked!.start, accepted.booked!.end], [target.start, target.end]);
  assert.deepEqual(accepted.booked!.travel, newTravel);
  assert.deepEqual(accepted.holdCleanup!.map((h) => h.holdId).sort(), ["t1", "t2"]);
  assert.deepEqual(dueReminders(staged, late, 10).map((r) => r.id), ["r_1"]);
  // Clearing the setting: staging no buffers releases the old ones atomically with the move.
  const cleared = commitTravel(stageTravel(l, "r_1", [], target, T0, "rc"), "r_1", "rc", T0).ledger.requests[0]!;
  assert.deepEqual(cleared.booked!.travel, []);
  assert.deepEqual(cleared.holdCleanup!.map((h) => h.holdId).sort(), ["t1", "t2"]);
  assert.throws(() => stageTravel(empty(), "nope", newTravel, target, T0), /no request/);
  // A booked meeting that closes (the owner cancels it) queues its buffers and any staged ones in the same write.
  const cancelled = updateRequest(staged, "r_1", { status: "cancelled" }, T0).requests[0]!;
  assert.deepEqual(cancelled.holdCleanup!.map((h) => h.holdId).sort(), ["t1", "t2", "t3", "t4"]);
  assert.equal(cancelled.pendingTravel, undefined);
});

test("set-travel writes only the buffers of one offer or of the booking", () => {
  const acct = "jean@example.com";
  const travel = [{ holdId: "t1", account: acct }, { holdId: "t2", account: acct }];
  const l = addRequest(empty(), input(), T0, "r_1");
  const set = setTravel(l, "r_1", travel, offer.start, T0);
  assert.deepEqual(set.requests[0]!.offered[0]!.travel, travel);
  assert.throws(() => setTravel(l, "r_1", travel, "2031-01-01T10:00:00Z", T0), /no offer starting/);
  assert.throws(() => setTravel(l, "r_1", [{ holdId: "" } as never], offer.start, T0), /travel hold/);
  const booked = updateRequest(l, "r_1", { status: "booked", eventId: "e1", booked: { start: offer.start, end: offer.end, account: acct } }, T0);
  const withTravel = setTravel(booked, "r_1", travel, undefined, T0);
  assert.deepEqual(withTravel.requests[0]!.booked!.travel, travel);
  assert.equal("travel" in setTravel(withTravel, "r_1", [], undefined, T0).requests[0]!.booked!, false);
});

test("monitor nudges the other person once after a day; a staged replacement keeps the marker and waits, and promotion resets it", () => {
  const offered = addRequest(empty(), input({ chatUid: "chat_1" }), T0, "r_1");
  assert.equal(monitor(offered, T0 + 23 * HOUR).waitingOnThem.length, 0);
  assert.equal(monitor(offered, T0 + 24 * HOUR).waitingOnThem.length, 1);
  const nudged = updateRequest(offered, "r_1", { personNudgedAt: new Date(T0 + 24 * HOUR).toISOString() }, T0 + 24 * HOUR);
  assert.equal(monitor(nudged, T0 + 25 * HOUR).waitingOnThem.length, 0);
  // Staging a replacement does not clear the marker or allow a nudge while it is in flight, and a discard leaves it as it was.
  const staged = saveRequest(nudged, input({ chatUid: "chat_1", offered: [{ ...offer, holdId: "h2" }] }), T0 + 30 * HOUR, "r_2", "rev1");
  assert.equal(staged.requests[0]!.personNudgedAt, new Date(T0 + 24 * HOUR).toISOString());
  assert.equal(monitor(staged, T0 + 60 * HOUR).waitingOnThem.length, 0);
  assert.equal(settleOffer(staged, "r_1", "rev1", "discard", T0 + 31 * HOUR).requests[0]!.personNudgedAt, new Date(T0 + 24 * HOUR).toISOString());
  // Promotion is a new offer: the marker is cleared and the next nudge is due a day later.
  const promoted = settleOffer(staged, "r_1", "rev1", "promote", T0 + 31 * HOUR);
  assert.equal(promoted.requests[0]!.personNudgedAt, undefined);
  assert.equal(monitor(promoted, T0 + 54 * HOUR).waitingOnThem.length, 0);
  assert.equal(monitor(promoted, T0 + 55 * HOUR).waitingOnThem.length, 1);
  // A direct replacement (no group yet) resets it at once.
  const direct = saveRequest(updateRequest(addRequest(empty(), input(), T0, "r_9"), "r_9", { personNudgedAt: new Date(T0).toISOString() }, T0), input({ offered: [{ ...offer, holdId: "h3" }] }), T0 + HOUR, "r_10");
  assert.equal(direct.requests[0]!.personNudgedAt, undefined);
});

test("buffers of an owner-approved out-of-hours time live on the pending approval, and are booked or cleaned up with it", () => {
  const acct = "jean@example.com";
  const pendingStart = "2026-10-03T22:00:00-03:00";
  const pendingOwner = { start: pendingStart, end: "2026-10-03T22:30:00-03:00", askedAt: new Date(T0).toISOString() };
  const travel = [{ holdId: "t1", account: acct }, { holdId: "t2", account: acct }];
  let l = addRequest(empty(), input(), T0, "r_1");
  l = updateRequest(l, "r_1", { pendingOwner }, T0);
  // The time is no offer, so set-travel parks the buffers on the pending approval instead of refusing.
  const held = setTravel(l, "r_1", travel, pendingStart, T0);
  assert.deepEqual(held.requests[0]!.pendingOwner!.travel, travel);
  assert.deepEqual(held.requests[0]!.offered, l.requests[0]!.offered);
  // A retry that holds a new pair displaces the first one into cleanup, in the same write.
  const retry = [{ holdId: "t3", account: acct }, { holdId: "t4", account: acct }];
  const again = setTravel(held, "r_1", retry, pendingStart, T0);
  assert.deepEqual(again.requests[0]!.pendingOwner!.travel, retry);
  assert.deepEqual(again.requests[0]!.holdCleanup!.map((h) => h.holdId), ["t1", "t2"]);
  // Declined or replaced: they go to cleanup.
  const declined = updateRequest(held, "r_1", { pendingOwner: null }, T0);
  assert.deepEqual(declined.requests[0]!.holdCleanup!.map((h) => h.holdId), ["t1", "t2"]);
  // Booked for that time (as record-booking does): the booking owns them, nothing is queued.
  const booked = updateRequest(held, "r_1", { status: "booked", eventId: "e1", pendingOwner: null, booked: { start: pendingStart, end: pendingOwner.end, account: acct, travel } }, T0);
  assert.equal(booked.requests[0]!.holdCleanup, undefined);
});

test("a re-offer to an existing group stays staged until its send succeeds", () => {
  const original = addRequest(empty(), input({ chatUid: "chat_1" }), T0 - 10 * HOUR, "r_1");
  const newOffer = { ...offer, start: "2026-09-30T12:00:00-03:00", holdId: "h_new" };
  const staged = saveRequest(original, input({ chatUid: "chat_1", offered: [newOffer] }), T0, "r_2", "rev1");
  const request = staged.requests[0]!;
  // The delivered offer, its age and its holds are untouched, and nothing is queued for deletion yet.
  assert.deepEqual(request.offered, original.requests[0]!.offered);
  assert.equal(request.offeredAt, original.requests[0]!.offeredAt);
  assert.deepEqual(request.holdCleanup, []);
  assert.deepEqual(request.pendingOffer, { revision: "rev1", offered: [newOffer], offeredAt: new Date(T0).toISOString() });
  // The poll's expiry and cleanup reads never see the staged holds as current or deletable.
  assert.deepEqual(cleanupList(staged), []);

  const promoted = settleOffer(staged, "r_1", "rev1", "promote", T0 + HOUR).requests[0]!;
  assert.deepEqual(promoted.offered, [newOffer]);
  assert.equal(promoted.offeredAt, new Date(T0 + HOUR).toISOString());
  assert.equal(promoted.pendingOffer, undefined);
  assert.deepEqual(promoted.holdCleanup, [{ holdId: "h1", account: offer.account }]);

  const discarded = settleOffer(staged, "r_1", "rev1", "discard", T0 + HOUR).requests[0]!;
  assert.deepEqual(discarded.offered, original.requests[0]!.offered);
  assert.equal(discarded.offeredAt, original.requests[0]!.offeredAt);
  assert.equal(discarded.pendingOffer, undefined);
  assert.deepEqual(discarded.holdCleanup, [{ holdId: "h_new", account: offer.account }]);
});

test("an offer being sent is exclusive: no second save, no expiry, and only its own revision settles it", () => {
  const original = addRequest(empty(), input({ chatUid: "chat_1" }), T0 - 10 * HOUR, "r_1");
  const first = saveRequest(original, input({ chatUid: "chat_1", offered: [{ ...offer, holdId: "h_a" }] }), T0, "r_2", "rev1");
  // A second save is refused while the first is in flight, so it cannot queue the first one's holds.
  assert.throws(() => saveRequest(first, input({ chatUid: "chat_1", offered: [{ ...offer, holdId: "h_b" }] }), T0 + HOUR / 2, "r_3", "rev2"), /already has an offer being sent/);
  // Nor does the 48-hour expiry close a request whose send has not settled.
  assert.deepEqual(expiredRequests(first, 48, T0 + 100 * HOUR), []);
  assert.equal(expiredRequests(original, 48, T0 + 100 * HOUR).length, 1);
  // A revision that is not the staged one changes nothing.
  assert.equal(settleOffer(first, "r_1", "other", "promote", T0 + HOUR), first);
  assert.equal(settleOffer(first, "r_1", "other", "discard", T0 + HOUR), first);
  // A stage that reuses the delivered hold does not queue it on discard or promote.
  const reuse = saveRequest(original, input({ chatUid: "chat_1", offered: [offer] }), T0, "r_2", "rev3");
  assert.deepEqual(settleOffer(reuse, "r_1", "rev3", "discard", T0 + HOUR).requests[0]!.holdCleanup, []);
  assert.deepEqual(settleOffer(reuse, "r_1", "rev3", "promote", T0 + HOUR).requests[0]!.holdCleanup, []);
  // A request that closed while the send was in flight keeps its old holds and drops the staged ones.
  const booked = updateRequest(first, "r_1", { status: "booked", eventId: "e1" }, T0 + HOUR);
  const closed = settleOffer(booked, "r_1", "rev1", "promote", T0 + 2 * HOUR).requests[0]!;
  assert.deepEqual(closed.offered, original.requests[0]!.offered);
  assert.deepEqual(closed.holdCleanup, [{ holdId: "h_a", account: offer.account }]);
});

test("a staged offer left by a dead turn is discarded after fifteen minutes", () => {
  const original = addRequest(empty(), input({ chatUid: "chat_1" }), T0 - 10 * HOUR, "r_1");
  const staged = saveRequest(original, input({ chatUid: "chat_1", offered: [{ ...offer, holdId: "h_a" }] }), T0, "r_2", "rev1");
  assert.equal(discardStaleOffers(staged, T0 + 14 * 60_000, 15 * 60_000), staged);
  const swept = discardStaleOffers(staged, T0 + 16 * 60_000, 15 * 60_000).requests[0]!;
  assert.equal(swept.pendingOffer, undefined);
  assert.deepEqual(swept.holdCleanup, [{ holdId: "h_a", account: offer.account }]);
});

test("find by chat and sender resolves a replacement offer without a chat link", () => {
  let l = addRequest(empty(), input({ chatUid: "c1" }), T0, "r_1");
  l = updateRequest(l, "r_1", { status: "dropped" }, T0 + HOUR);
  const nextOffer = { ...offer, start: "2026-09-29T12:30:00-03:00", end: "2026-09-29T13:00:00-03:00", holdId: "h2" };
  l = addRequest(l, input({ handle: "5551234567", offered: [nextOffer] }), T0 + 2 * HOUR, "r_2");

  // The unqualified chat lookup sees closed A; sender-aware lookup must pick B.
  assert.equal(findByChat(l, "c1")?.id, "r_1");
  assert.equal(findByChat(l, "c1", "+15551234567")?.id, "r_2");
  assert.equal(findOpenByHandle(l, "+15551234567")?.id, "r_2");
  assert.equal(findByChat(l, "c1", "+15551234567")?.offered[0]?.holdId, "h2");
  assert.equal(findByChat(l, "c2"), undefined);
});

test("CLI sender-aware chat lookup prefers open request over closed chat history", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  saveCli(env, input({ chatUid: "c1" }));
  const old = cli("ledger.ts", ["find", "--chat", "c1"], env).json.request;
  cli("ledger.ts", ["update", "--id", old.id, "--json", '{"status":"dropped"}'], env);
  const replacement = saveCli(env, input({ offered: [{ ...offer, holdId: "h2" }] })).json.request;
  const current = cli("ledger.ts", ["find", "--chat", "c1", "--handles-file", handlesFile("+15551234567")], env);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.json.request.id, replacement.id);
});

test("CLI combined lookup returns a closed chat request when the sender has no open request", () => {
  for (const status of ["booked", "dropped", "expired"] as const) {
    const home = tmpHome();
    const env = { MEETLY_HOME: home };
    const created = saveCli(env, input({ chatUid: "c1" }));
    const request = created.json.request;
    cli("ledger.ts", ["update", "--id", request.id, "--json", JSON.stringify({ status })], env);

    const result = cli("ledger.ts", ["find", "--chat", "c1", "--handles-file", handlesFile("+15551234567")], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.request.id, request.id);
    assert.equal(result.json.request.status, status);
  }
});

test("sender-aware chat lookup does not hide an open request linked to another chat", () => {
  let l = addRequest(empty(), input({ chatUid: "c1" }), T0, "r_closed");
  l = updateRequest(l, "r_closed", { status: "dropped" }, T0 + HOUR);
  l = addRequest(l, input({ chatUid: "c2", offered: [{ ...offer, holdId: "h2" }] }), T0 + 2 * HOUR, "r_open");

  const chatResult = findByChat(l, "c1", "+15551234567");
  const handleResult = findOpenByHandle(l, "+15551234567");
  assert.equal(chatResult?.id, "r_closed");
  assert.equal(handleResult?.id, "r_open");
  assert.notEqual(chatResult?.id, handleResult?.id);
  assert.equal(handleResult?.chatUid, "c2");
});

test("update resets offeredAt with new offers and rejects unknown keys", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = updateRequest(l, "r_1", { chatUid: "c1" }, T0 + HOUR);
  assert.equal(l.requests[0]!.offeredAt, new Date(T0).toISOString());
  assert.equal(l.requests[0]!.updatedAt, new Date(T0 + HOUR).toISOString());
  l = updateRequest(l, "r_1", { offered: [{ ...offer, holdId: "h9" }] }, T0 + 2 * HOUR);
  assert.equal(l.requests[0]!.offeredAt, new Date(T0 + 2 * HOUR).toISOString());
  assert.throws(() => updateRequest(l, "r_1", { handle: "x" } as never, T0), /unknown key/);
  assert.throws(() => updateRequest(l, "r_1", { status: "lost" } as never, T0), /status/);
  assert.throws(() => updateRequest(l, "nope", { status: "dropped" }, T0), /no request/);
  // The attendee email is kept in the request, lowercased and validated, and a new offer does not erase it.
  const withEmail = updateRequest(l, "r_1", { attendeeEmail: " Ana@Example.com " }, T0);
  assert.equal(withEmail.requests[0]!.attendeeEmail, "ana@example.com");
  assert.throws(() => updateRequest(l, "r_1", { attendeeEmail: "ana" }, T0), /email/);
  assert.equal(saveRequest(withEmail, input({ offered: [{ ...offer, holdId: "h7" }] }), T0, "r_x").requests[0]!.attendeeEmail, "ana@example.com");
  assert.throws(() => updateRequest(withEmail, "r_1", { attendeeEmail: null } as never, T0), /email/);
});

test("expired: 48 hours after the offer, open requests only", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = addRequest(l, input({ handle: "+15559999999" }), T0, "r_2");
  l = updateRequest(l, "r_2", { status: "booked" }, T0);
  assert.deepEqual(expiredRequests(l, 48, T0 + 47 * HOUR), []);
  assert.deepEqual(expiredRequests(l, 48, T0 + 48 * HOUR).map((r) => r.id), ["r_1"]);
  // An approved request counts its hold time from the approval, so an approval just before expiry is not raced.
  const approved = updateRequest(l, "r_1", { ownerApprovedAt: new Date(T0 + 47 * HOUR).toISOString() }, T0 + 47 * HOUR);
  assert.deepEqual(expiredRequests(approved, 48, T0 + 48 * HOUR), []);
  assert.deepEqual(expiredRequests(approved, 48, T0 + 95 * HOUR).map((r) => r.id), ["r_1"]);
});

test("expiring claims each request once, queues its holds, and returns it as it was", () => {
  let l = addRequest(empty(), input({ origin: "inbound", ownerApprovalAt: new Date(T0).toISOString(), offered: [{ ...offer, holdId: "h1" }] }), T0, "r_1");
  const out = expireRequests(l, 48, T0 + 48 * HOUR);
  assert.deepEqual(out.claimed.map((r) => [r.id, r.status, r.ownerApprovalAt]), [["r_1", "offered", new Date(T0).toISOString()]]);
  const closed = out.ledger.requests[0]!;
  assert.equal(closed.status, "expired");
  assert.equal("ownerApprovalAt" in closed, false);
  assert.deepEqual(closed.holdCleanup, [{ holdId: "h1", account: offer.account }]);
  // A second pass finds nothing, and a request refreshed with new holds is not the one that was claimed.
  assert.deepEqual(expireRequests(out.ledger, 48, T0 + 49 * HOUR).claimed, []);
  const refreshed = saveRequest(l, input({ origin: "inbound", ownerApprovalAt: new Date(T0 + 47 * HOUR).toISOString(), offered: [{ ...offer, holdId: "h2" }] }), T0 + 47 * HOUR, "r_2");
  assert.deepEqual(expireRequests(refreshed, 48, T0 + 48 * HOUR).claimed, []);
});

test("cleanup lists only requests with pending hold deletes", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = addRequest(l, input({ handle: "+15559999999" }), T0, "r_2");
  l = updateRequest(l, "r_2", { holdCleanup: [{ holdId: "h7", account: "jean@example.com" }], status: "expired" }, T0);
  l = updateRequest(l, "r_1", { holdCleanup: [] }, T0);
  assert.deepEqual(cleanupList(l).map((r) => r.id), ["r_2"]);
});

test("closure time stays fixed when a closed request gets another log entry", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = updateRequest(l, "r_1", { status: "cancelled" }, T0 + HOUR);
  const closedAt = l.requests[0]!.closedAt;
  assert.equal(closedAt, new Date(T0 + HOUR).toISOString());
  l = appendLog(l, "r_1", "owner notified", T0 + 10 * HOUR);
  assert.equal(l.requests[0]!.closedAt, closedAt);
  assert.equal(pipeline(l, T0 + 11 * HOUR).closed[0]!.closedAt, closedAt);
  const legacy = { requests: [{ ...l.requests[0]!, closedAt: undefined, log: undefined, updatedAt: new Date(T0 + 5 * HOUR).toISOString() }] };
  // A legacy row with no closing time falls back to its last update, never its creation.
  assert.equal(pipeline(legacy, T0 + 2 * 24 * HOUR).closed[0]!.closedAt, new Date(T0 + 5 * HOUR).toISOString());
});

test("pendingOwner is set, listed and cleared", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  const pending = { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T10:30:00-03:00", askedAt: new Date(T0).toISOString() };
  l = updateRequest(l, "r_1", { pendingOwner: pending }, T0);
  assert.deepEqual(pendingOwnerList(l).map((r) => r.pendingOwner), [pending]);
  assert.throws(() => updateRequest(l, "r_1", { pendingOwner: { ...pending, start: "sat" } }, T0), /pendingOwner/);
  l = updateRequest(l, "r_1", { pendingOwner: null }, T0);
  assert.equal("pendingOwner" in l.requests[0]!, false);
  assert.deepEqual(pendingOwnerList(l), []);
  l = updateRequest(l, "r_1", { pendingOwner: pending, status: "booked" }, T0);
  assert.deepEqual(pendingOwnerList(l), []);
});

test("save records the owner approval hold together with the offer", () => {
  const at = new Date(T0).toISOString();
  const l = saveRequest(empty(), input({ origin: "inbound", ownerApprovalAt: at }), T0, "r_1");
  assert.equal(l.requests[0]!.ownerApprovalAt, at);
  assert.deepEqual(ownerApprovalList(l, true).map((r) => r.id), ["r_1"]);
  // The gate is not tied to who asked: an owner request with no group waits the same way.
  assert.equal(saveRequest(empty(), input({ origin: "owner", ownerApprovalAt: at }), T0, "r_1").requests[0]!.ownerApprovalAt, at);
  assert.throws(() => saveRequest(empty(), input({ origin: "inbound", ownerApprovalAt: "soon" }), T0, "r_1"), /ownerApprovalAt/);
  const reoffered = saveRequest(updateRequest(l, "r_1", { ownerApprovedAt: at }, T0), input({ origin: "inbound", ownerApprovalAt: at }), T0 + HOUR, "r_2");
  assert.equal(reoffered.requests[0]!.ownerApprovedAt, undefined);
  assert.equal(reoffered.requests[0]!.ownerApprovalAt, at);
  // Stale options: a fresh offer that is itself pending replaces the pending request in place.
  const fresh = saveRequest(l, input({ origin: "inbound", ownerApprovalAt: new Date(T0 + HOUR).toISOString(), offered: [{ ...offer, holdId: "h_fresh" }] }), T0 + HOUR, "r_2");
  assert.equal(fresh.requests.length, 1);
  assert.equal(fresh.requests[0]!.id, "r_1");
  assert.equal(fresh.requests[0]!.offered[0]!.holdId, "h_fresh");
  assert.equal(fresh.requests[0]!.ownerApprovedAt, undefined);
});

test("owner gate requests wait for owner approval and appear in the approvals list", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = updateRequest(l, "r_1", { ownerApprovalAt: new Date(T0).toISOString() }, T0);
  assert.deepEqual(ownerApprovalList(l, true).map((r) => r.id), ["r_1"]);
  assert.equal(stageOf(l.requests[0]!, T0), "waiting_on_us");
  assert.equal(findByChat(l, "guest-chat", input().handle), undefined);
  assert.throws(() => saveRequest(l, input({ chatUid: "guest-chat" }), T0 + HOUR, "r_2"), /waiting for owner approval/);
  assert.throws(() => updateRequest(l, "r_1", { chatUid: "guest-chat" }, T0 + HOUR), /waiting for owner approval/);
  assert.throws(() => updateRequest(l, "r_1", { ownerApprovalAt: "soon" }, T0), /ownerApprovalAt/);
  // A request is saved already gated, in one write, and a gated offer is replaced only by one with a fresh approval time.
  const gate = new Date(T0).toISOString();
  const saved = saveRequest(empty(), input({ ownerApprovalAt: gate }), T0, "r_g");
  assert.deepEqual(ownerApprovalList(saved, true).map((r) => r.id), ["r_g"]);
  assert.throws(() => saveRequest(saved, input({ ownerApprovalAt: gate }), T0 + HOUR, "r_h"), /new ownerApprovalAt/);
  const fresh = saveRequest(saved, input({ offered: [{ ...offer, holdId: "h9" }], ownerApprovalAt: new Date(T0 + HOUR).toISOString() }), T0 + HOUR, "r_h");
  assert.equal(fresh.requests[0]!.ownerApprovalAt, new Date(T0 + HOUR).toISOString());
  assert.deepEqual(fresh.requests[0]!.holdCleanup!.map((h) => h.holdId), ["h1"]);
  assert.throws(() => saveRequest(empty(), input({ ownerApprovalAt: "soon" }), T0, "r_x"), /ownerApprovalAt/);
  const approvedButUnknown = updateRequest(l, "r_1", { ownerApprovedAt: new Date(T0 + 6 * HOUR).toISOString() }, T0 + 6 * HOUR);
  // Approved with no chat is an uncertain delivery, never a resumable approval: it is not listed, and a second yes does nothing.
  assert.equal(stageOf(approvedButUnknown.requests[0]!, T0 + 6 * HOUR), "delivery_unknown");
  assert.deepEqual(ownerApprovalList(approvedButUnknown, true), []);
  assert.equal(yes(approvedButUnknown, "r_1", T0 + 7 * HOUR).approved, false);
  l = updateRequest(l, "r_1", { chatUid: "approved-chat", ownerApprovedAt: new Date(T0 + 6 * HOUR).toISOString() }, T0 + 6 * HOUR);
  assert.deepEqual(ownerApprovalList(l, true), []);
  assert.equal(findByChat(l, "approved-chat", input().handle)?.id, "r_1");
  assert.equal(stageOf(l.requests[0]!, T0), "sent");
});

test("the CLI expire closes an old request once and queues its holds", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  const id = saveCli(env, input({ chatUid: "chat_1" })).json.request.id;
  assert.deepEqual(cli("ledger.ts", ["expire"], env).json, { requests: [] });
  const expired = cli("ledger.ts", ["expire", "--hours", "0"], env).json.requests;
  assert.deepEqual(expired.map((r: { id: string; status: string; chatUid: string }) => [r.id, r.status, r.chatUid]), [[id, "offered", "chat_1"]]);
  assert.equal(cli("ledger.ts", ["find", "--chat", "chat_1"], env).json.request.status, "expired");
  assert.deepEqual(cli("ledger.ts", ["expire", "--hours", "0"], env).json, { requests: [] });
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [{ id, holdCleanup: [{ holdId: "h1", account: offer.account }] }] });
});

test("a delivery goes only to the request that was authorized: a replaced offer or approval, or a closed request, stops the stale opener", () => {
  const gate = new Date(T0).toISOString();
  const waiting = saveRequest(empty(), input({ ownerApprovalAt: gate }), T0, "r_1");
  const approved = yes(waiting, "r_1", T0 + HOUR).ledger;
  const r = approved.requests[0]!;
  const seen = { handle: r.handle, offeredAt: r.offeredAt, ownerApprovedAt: r.ownerApprovedAt };
  assert.doesNotThrow(() => assertDeliverable(approved, "r_1", seen, true));
  // Not approved, another person, another offer or approval, or closed: refused.
  assert.throws(() => assertDeliverable(waiting, "r_1", seen, true), /not approved/);
  assert.throws(() => assertDeliverable(approved, "r_1", { ...seen, handle: "+15550000000" }, true), /changed since it was authorized/);
  const replaced = saveRequest(approved, input({ offered: [{ ...offer, holdId: "h9" }], ownerApprovalAt: new Date(T0 + 3 * HOUR).toISOString() }), T0 + 3 * HOUR, "r_2");
  assert.throws(() => assertDeliverable(replaced, "r_1", seen, true), /not approved|changed since/);
  const reapproved = yes(replaced, "r_1", T0 + 4 * HOUR).ledger;
  assert.throws(() => assertDeliverable(reapproved, "r_1", seen, true), /changed since it was authorized/);
  assert.throws(() => assertDeliverable(expireRequests(approved, 48, T0 + 200 * HOUR).ledger, "r_1", seen, true), /no longer open/);
  // With the gate on, a request with no marker at all (saved before markers existed) is not approved either; with it off it is.
  const legacy = addRequest(empty(), input({}), T0, "r_1");
  const legacySeen = { handle: legacy.requests[0]!.handle, offeredAt: legacy.requests[0]!.offeredAt };
  assert.throws(() => assertDeliverable(legacy, "r_1", legacySeen, true), /not approved/);
  assert.doesNotThrow(() => assertDeliverable(legacy, "r_1", legacySeen, false));
  // It is not stuck: with the gate on it is listed, and the owner can approve or decline it like a gated one.
  assert.deepEqual(ownerApprovalList(legacy, true).map((r) => r.id), ["r_1"]);
  assert.deepEqual(ownerApprovalList(legacy, false), []);
  const legacyYes = approveRequest(legacy, "r_1", T0 + HOUR, legacySeen.offeredAt, true);
  assert.equal(legacyYes.approved, true);
  assert.doesNotThrow(() => assertDeliverable(legacyYes.ledger, "r_1", { ...legacySeen, ownerApprovedAt: legacyYes.ledger.requests[0]!.ownerApprovedAt }, true));
  assert.equal(declineRequest(legacy, "r_1", T0 + HOUR, true).declined, true);
  assert.equal(approveRequest(legacy, "r_1", T0 + HOUR, legacySeen.offeredAt, false).approved, false, "with the gate off there is nothing to approve");
});

test("the owner's yes is claimed atomically: only a request still open and waiting can be approved", () => {
  const gate = new Date(T0).toISOString();
  const waiting = saveRequest(empty(), input({ ownerApprovalAt: gate }), T0, "r_1");
  const claimed = yes(waiting, "r_1", T0 + HOUR);
  assert.equal(claimed.approved, true);
  assert.equal(claimed.ledger.requests[0]!.ownerApprovedAt, new Date(T0 + HOUR).toISOString());
  // Once approved, it leaves the list and a second yes does nothing; with a group it still does nothing.
  assert.equal(yes(claimed.ledger, "r_1", T0 + 2 * HOUR).approved, false);
  assert.deepEqual(ownerApprovalList(claimed.ledger, true), []);
  assert.deepEqual(ownerApprovalList(waiting, true).map((r) => r.id), ["r_1"]);
  const opened = updateRequest(claimed.ledger, "r_1", { chatUid: "g1" }, T0 + 3 * HOUR);
  assert.equal(yes(opened, "r_1", T0 + 4 * HOUR).approved, false);
  assert.deepEqual(ownerApprovalList(opened, true), []);
  // The yes is for the times the owner saw: an offer replaced since then (another offeredAt) is not approved by it.
  const shown = waiting.requests[0]!.offeredAt;
  const reoffered = saveRequest(waiting, input({ offered: [{ ...offer, holdId: "h9" }], ownerApprovalAt: new Date(T0 + HOUR).toISOString() }), T0 + HOUR, "r_9");
  assert.notEqual(reoffered.requests[0]!.offeredAt, shown);
  assert.equal(approveRequest(reoffered, "r_1", T0 + 2 * HOUR, shown, true).approved, false);
  assert.equal(yes(reoffered, "r_1", T0 + 2 * HOUR).approved, true);
  // An unknown id, or a request the poll already expired, loses.
  assert.equal(yes(waiting, "nope", T0).approved, false);
  const expired = expireRequests(waiting, 48, T0 + 49 * HOUR).ledger;
  assert.equal(yes(expired, "r_1", T0 + 50 * HOUR).approved, false);
  // An approval just before expiry restarts the clock, so the poll cannot close it under the owner's turn.
  const late = yes(waiting, "r_1", T0 + 47 * HOUR).ledger;
  assert.deepEqual(expireRequests(late, 48, T0 + 49 * HOUR).claimed, []);
  // A re-offer to a group the request already has is never gated.
  const linked = addRequest(empty(), input({ chatUid: "g1" }), T0, "r_2");
  assert.throws(() => saveRequest(linked, input({ chatUid: "g1", ownerApprovalAt: gate }), T0, "r_3"), /already has a group/);
});

test("the owner's no closes the request and queues every hold in one write, only while it is waiting", () => {
  const gate = new Date(T0).toISOString();
  const waiting = saveRequest(empty(), input({ ownerApprovalAt: gate, offered: [{ ...offer, holdId: "h1" }, { ...offer, start: "2026-09-30T12:00:00-03:00", end: "2026-09-30T12:30:00-03:00", holdId: "h2" }] }), T0, "r_1");
  const out = declineRequest(waiting, "r_1", T0 + HOUR, true);
  assert.equal(out.declined, true);
  const r = out.ledger.requests[0]!;
  assert.deepEqual([r.status, r.ownerApprovalAt], ["dropped", undefined]);
  assert.deepEqual(r.holdCleanup!.map((h) => h.holdId).sort(), ["h1", "h2"]);
  assert.deepEqual(ownerApprovalList(out.ledger, true), []);
  // Already decided, expired or approved: no change.
  assert.equal(declineRequest(out.ledger, "r_1", T0 + 2 * HOUR, true).declined, false);
  assert.equal(declineRequest(yes(waiting, "r_1", T0).ledger, "r_1", T0, true).declined, false);
  assert.equal(declineRequest(waiting, "nope", T0, true).declined, false);
  // An offer's travel buffers are queued with its meeting hold, so a decline leaves none behind.
  const withTravel = saveRequest(empty(), input({ ownerApprovalAt: gate, offered: [{ ...offer, holdId: "h1", travel: [{ holdId: "t1", account: offer.account }, { holdId: "t2", account: offer.account }] }] }), T0, "r_t");
  assert.deepEqual(declineRequest(withTravel, "r_t", T0, true).ledger.requests[0]!.holdCleanup!.map((h) => h.holdId).sort(), ["h1", "t1", "t2"]);
});

test("ledger.ts save needs a finished setup", () => {
  const early = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15558880000" }))], { MEETLY_HOME: tmpHome() });
  assert.equal(early.status, 1);
  assert.match(early.stderr, /not set up/);
});

test("CLI add, find, update and cleanup round-trip", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  const added = saveCli(env, input({ handle: "+1 (555) 123-4567" }));
  assert.equal(added.status, 0, added.stderr);
  const id = added.json.request.id;
  assert.match(id, /^r_[0-9a-f]{8}$/);
  assert.equal(cli("ledger.ts", ["find", "--handles-file", handlesFile("5551234567")], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["find", "--handles-file", handlesFile("+15550000000")], env).json, { request: null });
  const patch = join(home, "patch.json");
  writeFileSync(patch, JSON.stringify({ chatUid: "chat_1" }));
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json-file", patch], env).json.request.chatUid, "chat_1");
  assert.equal(cli("ledger.ts", ["find", "--chat", "chat_1"], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["expire"], env).json, { requests: [] });
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [] });
  cli("ledger.ts", ["update", "--id", id, "--json", '{"holdCleanup":[{"holdId":"h1","account":"a"}]}'], env);
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [{ id, holdCleanup: [{ holdId: "h1", account: "a" }] }] });
  const pend = { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T10:30:00-03:00", askedAt: "2026-09-28T12:00:00Z" };
  cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify({ pendingOwner: pend })], env);
  assert.deepEqual(cli("ledger.ts", ["pending"], env).json.requests.map((r: { id: string }) => r.id), [id]);
  // The approval state is never written from a model-supplied payload: update, add and save refuse it; only save and add (derived from the configuration), the owner's approval tool, decline and expire write it.
  for (const bad of ['{"ownerApprovalAt":"2026-10-03T12:00:00Z"}', '{"ownerApprovedAt":"2026-10-03T12:00:00Z"}']) {
    const refused = cli("ledger.ts", ["update", "--id", id, "--json", bad], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /written only by/);
  }
  writeConfig(home);
  // A model-supplied approval marker is refused.
  const supplied = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15558880000", ownerApprovalAt: "2026-10-03T12:00:00Z" }))], env);
  assert.equal(supplied.status, 1);
  assert.match(supplied.stderr, /written only by/);
  // With the gate on (the default) an offer with no group waits, whoever the payload says asked: `origin` is written by
  // the model, so `owner` buys nothing.
  const gated = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15558880000" }))], env).json.request;
  assert.equal(typeof gated.ownerApprovalAt, "string");
  const claimedOwner = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15556660000", origin: "owner" }))], env).json.request;
  assert.equal(typeof claimedOwner.ownerApprovalAt, "string");
  // A chat uid the model supplies counts as "already has a group" only when the ledger linked that chat to a request of the
  // same person. A made-up uid and another contact's group are dropped and gated; the person's own known group is not gated.
  // A's group g1 exists in the ledger because the existing-group flow (`add`, in the group itself) linked it.
  const A = "+15555550000";
  assert.equal(cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: A, origin: "owner", chatUid: "g1" }))], env).json.request.chatUid, "g1");
  const crossed = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15554440001", chatUid: "g1" }))], env).json.request;
  assert.equal(typeof crossed.ownerApprovalAt, "string");
  assert.equal(crossed.chatUid, undefined);
  const synthetic = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15554440002", chatUid: "made-up" }))], env).json.request;
  assert.equal(typeof synthetic.ownerApprovalAt, "string");
  assert.equal(synthetic.chatUid, undefined);
  // The person's own group stays known after that request closes: an inbound re-offer there is not gated.
  const firstA = cli("ledger.ts", ["find", "--chat", "g1"], env).json.request;
  cli("ledger.ts", ["update", "--id", firstA.id, "--json", '{"status":"dropped"}'], env);
  const reoffer = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: A, chatUid: "g1" }))], env).json.request;
  assert.deepEqual([reoffer.ownerApprovalAt, reoffer.chatUid], [undefined, "g1"]);
  // A request that already has a group is never moved to a conflicting chat: B linked to gB cannot be re-pointed at A's g1.
  const B = "+15553330001";
  assert.equal(cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: B, origin: "owner", chatUid: "gB" }))], env).json.request.chatUid, "gB");
  const moved = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: B, chatUid: "g1", offered: [{ ...offer, holdId: "h77" }] }))], env);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /already linked to another group/);
  assert.equal(cli("ledger.ts", ["find", "--chat", "gB"], env).json.request.chatUid, "gB");
  // Its own group is fine (a re-offer is staged for it).
  assert.equal(cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: B, chatUid: "gB", offered: [{ ...offer, holdId: "h78" }] }))], env).status, 0);
  // The owner turned it off: nothing is gated.
  const off = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...off, ownerGate: false }));
  const ungated = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15554440000" }))], env).json.request;
  assert.equal(ungated.ownerApprovalAt, undefined);
  writeFileSync(join(home, "config.json"), JSON.stringify(off));
  // The plain inbound request, the one with another contact's group and the one with a made-up uid all wait for the owner.
  assert.deepEqual(cli("ledger.ts", ["approvals"], env).json.requests.map((r: { id: string }) => r.id).sort(), [gated.id, claimedOwner.id, crossed.id, synthetic.id, ungated.id].sort());
  // The one saved while the gate was off, with no group yet, waits for the owner too now that it is back on.
  // No script approves: only the owner's meetly_approve_request tool, which reads the turn from the runtime, can.
  const scripted = cli("ledger.ts", ["approve", "--id", gated.id], env);
  assert.equal(scripted.status, 1);
  assert.match(scripted.stderr, /meetly_approve_request/);
  for (const r of [gated, claimedOwner, crossed, synthetic, ungated]) assert.equal(cli("ledger.ts", ["decline", "--id", r.id], env).json.declined, true);
  assert.deepEqual(cli("ledger.ts", ["approvals"], env).json.requests, []);
  assert.equal(cli("ledger.ts", ["decline", "--id", gated.id], env).json.declined, false);
  // `add` is only the existing-group flow: it needs that group's chat (a request with no group is saved, and gated),
  // and a second open request for the person is refused.
  const addedBare = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: "+15551110000", origin: "owner" }))], env);
  assert.equal(addedBare.status, 1);
  assert.match(addedBare.stderr, /needs that group's chatUid/);
  assert.equal(cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: "+15551110000", chatUid: "g9" }))], env).status, 0);
  assert.match(cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: "+15551110000", chatUid: "g9" }))], env).stderr, /already exists/);
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h2" }] }))], env);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.json.request.id, id);
  assert.equal(saved.json.request.chatUid, "chat_1");
  // The person already has a group: the new offer is staged and the delivered one stays current.
  assert.equal(saved.json.request.offered[0].holdId, offer.holdId);
  assert.equal(saved.json.request.pendingOffer.offered[0].holdId, "h2");
  const revision = saved.json.request.pendingOffer.revision;
  assert.match(revision, /^[0-9a-f]{8}$/);
  const stale = cli("ledger.ts", ["discard-offer", "--id", id, "--revision", "0000"], env);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.json.settled, false);
  const discarded = cli("ledger.ts", ["discard-offer", "--id", id, "--revision", revision], env);
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(discarded.json.settled, true);
  assert.equal(discarded.json.request.offered[0].holdId, offer.holdId);
  assert.deepEqual(discarded.json.request.holdCleanup, [
    { holdId: "h1", account: "a" },
    { holdId: "h2", account: offer.account },
  ]);
  const restaged = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h3" }] }))], env);
  const promoted = cli("ledger.ts", ["promote-offer", "--id", id, "--revision", restaged.json.request.pendingOffer.revision], env);
  assert.equal(promoted.json.settled, true);
  assert.equal(promoted.json.request.offered[0].holdId, "h3");
  assert.equal(promoted.json.request.pendingOffer, undefined);
  assert.deepEqual(promoted.json.request.holdCleanup.map((h: { holdId: string }) => h.holdId), ["h1", "h2", "h1"]);
  const deleted = join(home, "deleted.json");
  writeFileSync(deleted, JSON.stringify({ holdId: "h2", account: offer.account }));
  const cleanup = cli("ledger.ts", ["cleanup-remove", "--id", id, "--json-file", deleted], env);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.deepEqual(cleanup.json.request.holdCleanup, [{ holdId: "h1", account: "a" }, { holdId: "h1", account: offer.account }]);
  // A promotion that did not take effect (the request closed first) is not reported as settled.
  const again = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h4" }] }))], env);
  cli("ledger.ts", ["update", "--id", id, "--json", '{"status":"dropped"}'], env);
  const closedPromote = cli("ledger.ts", ["promote-offer", "--id", id, "--revision", again.json.request.pendingOffer.revision], env);
  assert.equal(closedPromote.status, 0, closedPromote.stderr);
  assert.equal(closedPromote.json.settled, false);
  assert.equal(closedPromote.json.request.offered[0].holdId, "h3");
});

test("a corrupt ledger.json fails loudly", () => {
  const home = tmpHome();
  writeFileSync(join(home, "ledger.json"), "[oops");
  const r = cli("ledger.ts", ["find", "--handles-file", handlesFile("+15551234567")], { MEETLY_HOME: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ledger\.json/);
});

test("an owner cancellation finds the booked request by its event id and closes it as cancelled", () => {
  let l = addRequest(empty(), input({ chatUid: "c1" }), T0, "r_1");
  l = updateRequest(l, "r_1", { status: "booked", eventId: "ev_1", booked: { start: offer.start, end: offer.end, account: "a@example.com" } }, T0);
  assert.equal(findByEvent(l, "ev_1", "a@example.com")?.id, "r_1");
  assert.equal(findByEvent(l, "ev_other", "a@example.com"), undefined);
  // The same id on another account is another event: never this request.
  assert.equal(findByEvent(l, "ev_1", "b@example.com"), undefined);
  l = updateRequest(l, "r_1", { status: "cancelled" }, T0 + HOUR);
  assert.equal(l.requests[0]!.status, "cancelled");
  // A cancelled meeting is closed: no reminder, no expiry, and it frees the person for a new offer.
  assert.deepEqual(expiredRequests(l, 0, T0 + 100 * HOUR), []);
  assert.equal(findOpenByHandle(l, "+15551234567"), undefined);
  assert.equal(findByChat(l, "c1")?.status, "cancelled");
});

test("CLI find --event returns the request booked as that event", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const id = saveCli(env, input({ chatUid: "c1" })).json.request.id;
  // A booking with no recorded account never matches: the lookup fails closed.
  cli("ledger.ts", ["update", "--id", id, "--json", '{"status":"booked","eventId":"ev_1"}'], env);
  assert.deepEqual(cli("ledger.ts", ["find", "--event", "ev_1", "--account", "a@example.com"], env).json, { request: null });
  const booked = { start: offer.start, end: offer.end, account: "a@example.com" };
  cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify({ booked })], env);
  assert.equal(cli("ledger.ts", ["find", "--event", "ev_1", "--account", "a@example.com"], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["find", "--event", "ev_2", "--account", "a@example.com"], env).json, { request: null });
  assert.notEqual(cli("ledger.ts", ["find", "--event", "ev_1"], env).status, 0, "--event needs --account");
  const cancelled = cli("ledger.ts", ["update", "--id", id, "--json", '{"status":"cancelled"}'], env);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(cancelled.json.request.status, "cancelled");
});
