import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRequest, saveRequest, settleOffer, discardStaleOffers, removeCleanupRef, appendLog, cleanupList, pendingOwnerList, expiredRequests, findByChat, findByEvent, findOpenByHandle, normalizeHandle, sameHandle, updateRequest, monitor, pipeline, stageOf,
  type Ledger, type NewRequest,
} from "../skills/meetly/scripts/ledger.ts";
import { cli, tmpHome } from "./helpers.ts";

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
  cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "c1" }))], env);
  const old = cli("ledger.ts", ["find", "--chat", "c1"], env).json.request;
  cli("ledger.ts", ["update", "--id", old.id, "--json", '{"status":"dropped"}'], env);
  const replacement = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h2" }] }))], env).json.request;
  const current = cli("ledger.ts", ["find", "--chat", "c1", "--handle", "+15551234567"], env);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.json.request.id, replacement.id);
});

test("CLI combined lookup returns a closed chat request when the sender has no open request", () => {
  for (const status of ["booked", "dropped", "expired"] as const) {
    const home = tmpHome();
    const env = { MEETLY_HOME: home };
    const created = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "c1" }))], env);
    const request = created.json.request;
    cli("ledger.ts", ["update", "--id", request.id, "--json", JSON.stringify({ status })], env);

    const result = cli("ledger.ts", ["find", "--chat", "c1", "--handle", "+15551234567"], env);
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

test("CLI add, find, update, expired and cleanup round-trip", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  const added = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: "+1 (555) 123-4567" }))], env);
  assert.equal(added.status, 0, added.stderr);
  const id = added.json.request.id;
  assert.match(id, /^r_[0-9a-f]{8}$/);
  assert.equal(cli("ledger.ts", ["find", "--handle", "5551234567"], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["find", "--handle", "+15550000000"], env).json, { request: null });
  const patch = join(home, "patch.json");
  writeFileSync(patch, JSON.stringify({ chatUid: "chat_1" }));
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json-file", patch], env).json.request.chatUid, "chat_1");
  assert.equal(cli("ledger.ts", ["find", "--chat", "chat_1"], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["expired"], env).json, { requests: [] });
  assert.equal(cli("ledger.ts", ["expired", "--hours", "0"], env).json.requests.length, 1);
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [] });
  cli("ledger.ts", ["update", "--id", id, "--json", '{"holdCleanup":[{"holdId":"h1","account":"a"}]}'], env);
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [{ id, holdCleanup: [{ holdId: "h1", account: "a" }] }] });
  const pend = { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T10:30:00-03:00", askedAt: "2026-09-28T12:00:00Z" };
  cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify({ pendingOwner: pend })], env);
  assert.deepEqual(cli("ledger.ts", ["pending"], env).json.requests.map((r: { id: string }) => r.id), [id]);
  const dup = cli("ledger.ts", ["add", "--json", JSON.stringify(input())], env);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /already exists/);
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
  const r = cli("ledger.ts", ["find", "--handle", "+15551234567"], { MEETLY_HOME: home });
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
  const id = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "c1" }))], env).json.request.id;
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
