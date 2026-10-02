import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRequest, saveRequest, rollbackOffer, removeCleanupRef, cleanupList, pendingOwnerList, expiredRequests, findByChat, findOpenByHandle, normalizeHandle, sameHandle, updateRequest,
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

test("save replaces a duplicate open offer by normalized handle and preserves its id and chat link", () => {
  const original = addRequest(empty(), input({ chatUid: "chat_1" }), T0, "r_1");
  const updatedOffer = { ...offer, start: "2026-09-30T12:00:00-03:00", holdId: "h2" };
  const saved = saveRequest(original, input({ handle: "5551234567", offered: [updatedOffer] }), T0 + HOUR, "r_2");
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0]!.id, "r_1");
  assert.equal(saved.requests[0]!.chatUid, "chat_1");
  assert.deepEqual(saved.requests[0]!.offered, [updatedOffer]);
  assert.deepEqual(saved.requests[0]!.holdCleanup, [{ holdId: "h1", account: offer.account }]);
  assert.equal(saved.requests[0]!.offeredAt, new Date(T0 + HOUR).toISOString());
  assert.equal(findOpenByHandle(saved, "+15551234567")!.id, "r_1");
});

test("failed re-offer rollback restores offer age and cleanup refs before deleting new holds", () => {
  const original = addRequest(empty(), input({ chatUid: "chat_1" }), T0 - 10 * HOUR, "r_1");
  const withPendingCleanup = updateRequest(original, "r_1", { holdCleanup: [{ holdId: "h_pending", account: "jean@example.com" }] }, T0 - 5 * HOUR);
  const newOffer = { ...offer, start: "2026-09-30T12:00:00-03:00", holdId: "h_new" };
  const saved = saveRequest(withPendingCleanup, input({ chatUid: "chat_1", offered: [newOffer] }), T0, "r_2");
  const rolledBack = rollbackOffer(saved, "r_1", {
    offered: withPendingCleanup.requests[0]!.offered,
    offeredAt: withPendingCleanup.requests[0]!.offeredAt,
    holdCleanup: withPendingCleanup.requests[0]!.holdCleanup!,
  }, T0 + HOUR);
  const withoutCleanup = rollbackOffer(saved, "r_1", {
    offered: original.requests[0]!.offered, offeredAt: original.requests[0]!.offeredAt,
  }, T0 + HOUR);
  assert.deepEqual(withoutCleanup.requests[0]!.holdCleanup, [{ holdId: "h_new", account: "jean@example.com" }]);
  assert.deepEqual(rolledBack.requests[0]!.offered, withPendingCleanup.requests[0]!.offered);
  assert.equal(rolledBack.requests[0]!.offeredAt, withPendingCleanup.requests[0]!.offeredAt);
  assert.deepEqual(rolledBack.requests[0]!.holdCleanup, [
    { holdId: "h_pending", account: "jean@example.com" },
    { holdId: "h_new", account: "jean@example.com" },
  ]);
  assert.deepEqual(removeCleanupRef(rolledBack, "r_1", { holdId: "h_new", account: "jean@example.com" }, T0 + 2 * HOUR).requests[0]!.holdCleanup,
    [{ holdId: "h_pending", account: "jean@example.com" }]);
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
  assert.equal(saved.json.request.offered[0].holdId, "h2");
  assert.deepEqual(saved.json.request.holdCleanup, [
    { holdId: "h1", account: "a" },
    { holdId: "h1", account: offer.account },
  ]);
  const rollback = join(home, "rollback.json");
  writeFileSync(rollback, JSON.stringify({
    offered: [offer], offeredAt: "2026-09-28T12:00:00.000Z",
    holdCleanup: [{ holdId: "h1", account: "a" }],
  }));
  const rolledBack = cli("ledger.ts", ["rollback-offer", "--id", id, "--json-file", rollback], env);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.deepEqual(rolledBack.json.request.offered, [offer]);
  assert.equal(rolledBack.json.request.offeredAt, "2026-09-28T12:00:00.000Z");
  assert.deepEqual(rolledBack.json.request.holdCleanup, [
    { holdId: "h1", account: "a" },
    { holdId: "h2", account: offer.account },
  ]);
  const deleted = join(home, "deleted.json");
  writeFileSync(deleted, JSON.stringify({ holdId: "h2", account: offer.account }));
  const cleanup = cli("ledger.ts", ["cleanup-remove", "--id", id, "--json-file", deleted], env);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.deepEqual(cleanup.json.request.holdCleanup, [{ holdId: "h1", account: "a" }]);
});

test("a corrupt ledger.json fails loudly", () => {
  const home = tmpHome();
  writeFileSync(join(home, "ledger.json"), "[oops");
  const r = cli("ledger.ts", ["find", "--handle", "+15551234567"], { MEETLY_HOME: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ledger\.json/);
});
