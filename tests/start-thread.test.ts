import { test } from "node:test";
import assert from "node:assert/strict";
import { startThread } from "../skills/meetly/scripts/start-thread.ts";
import { beforeEach, afterEach } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, seedRequest, tmpHome } from "./helpers.ts";

const identity = {
  line: { uid: "line_me" },
  chats: [{
    uid: "dm",
    status: "active",
    participants: [
      { type: "agent", relationship: "self", line: { uid: "line_me" } },
      { type: "member", role: "owner", provider_key: "+5511999990000" },
    ],
  }],
};

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(post: () => Response | Promise<Response>, calls: Call[] = [], me: unknown = identity): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/agents/me")) return new Response(JSON.stringify(me), { status: 200 });
    return post();
  }) as typeof fetch;
}
const base = "https://api.plow.test/";
const args = { members: ["+15551234567"], body: "Hi Ana, this is Meetly, Jean's assistant.", requestId: "r_1" };

// Every group is opened for one saved request, so each test starts with one for this person.
let home = "";
let prior: string | undefined;
beforeEach(() => { prior = process.env.MEETLY_HOME; home = tmpHome(); process.env.MEETLY_HOME = home; seedRequest(home); });
afterEach(() => { if (prior === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = prior; });

test("posts the same chat the plow_start_thread tool would", async () => {
  const calls: Call[] = [];
  const out = await startThread({ ...args, fetch: fakeFetch(() => new Response('{"uid":"chat_9"}', { status: 201 }), calls), base, token: "tok" });
  assert.deepEqual(out, { chatUid: "chat_9", messageSent: true });
  const post = calls[1]!;
  assert.equal(post.url, "https://api.plow.test/v1/chats");
  assert.equal(post.init?.method, "POST");
  assert.equal(post.init?.redirect, "error");
  assert.equal((post.init?.headers as Record<string, string>).Authorization, "Bearer tok");
  const body = JSON.parse(String(post.init?.body));
  assert.equal(body.line_uid, "line_me");
  assert.deepEqual(body.members, ["+15551234567", "+5511999990000"]);
  assert.equal(body.trusted, true);
  assert.equal(body.body, args.body);
  assert.match(body.idempotency_key, /^[0-9a-f]{64}$/);
});

test("the same request and people give the same idempotency key even if wording changes", async () => {
  const keys: string[] = [];
  const fetch = fakeFetch(() => new Response('{"uid":"c"}', { status: 200 }), []);
  const spy = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) keys.push(JSON.parse(String(init.body)).idempotency_key);
    return fetch(url, init);
  }) as typeof fetch;
  await startThread({ ...args, fetch: spy, base, token: "t" });
  await startThread({ ...args, fetch: spy, base, token: "t" });
  await startThread({ ...args, body: "Hi Ana, here are the times Jean can meet.", fetch: spy, base, token: "t" });
  seedRequest(home, { id: "r_2" });
  await startThread({ ...args, requestId: "r_2", fetch: spy, base, token: "t" });
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
  assert.notEqual(keys[0], keys[3]);
});

test("a server error or a lost connection means delivery is unknown", async () => {
  for (const post of [
    () => new Response("", { status: 502 }),
    () => new Response("", { status: 408 }),
    () => { throw new TypeError("fetch failed"); },
  ]) {
    assert.deepEqual(await startThread({ ...args, fetch: fakeFetch(post), base, token: "t" }), { chatUid: null, deliveryUnknown: true });
  }
});

test("a refused request, bad phones or no owner handle fail loudly", async () => {
  await assert.rejects(startThread({ ...args, fetch: fakeFetch(() => new Response('{"error":"nope"}', { status: 422 })), base, token: "t" }), /HTTP 422/);
  await assert.rejects(startThread({ ...args, members: ["ana"], fetch: fakeFetch(() => new Response("{}")), base, token: "t" }), /E\.164.*or an email/);
  await assert.rejects(startThread({ ...args, members: [], fetch: fakeFetch(() => new Response("{}")), base, token: "t" }), /at least one/);
  await assert.rejects(startThread({ ...args, body: " ", fetch: fakeFetch(() => new Response("{}")), base, token: "t" }), /body/);
  const noHandle = structuredClone(identity);
  delete (noHandle.chats[0]!.participants[1] as { provider_key?: string }).provider_key;
  await assert.rejects(startThread({ ...args, fetch: fakeFetch(() => new Response("{}"), [], noHandle), base, token: "t" }), /no owner handle/);
  await assert.rejects(startThread({ ...args, fetch: fakeFetch(() => new Response("{}"), [], { line: { uid: "x" }, chats: [] }), base, token: "t" }), /has not texted/);
});

test("the CLI reads its input from a file and needs a request and the Plow env", () => {
  const input = (extra: object) => {
    const path = join(home, `in-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify({ members: ["+15551234567"], body: "hi; $(touch pwned)", ...extra }));
    return path;
  };
  const noRequest = cli("start-thread.ts", ["--input-file", input({})], { MEETLY_HOME: home, PLOW_API_BASE: "http://127.0.0.1:9", PLOW_AGENT_TOKEN: "t" });
  assert.equal(noRequest.status, 1);
  assert.match(noRequest.stderr, /requestId/);
  const noEnv = cli("start-thread.ts", ["--input-file", input({ requestId: "r_1" })], { MEETLY_HOME: home, PLOW_API_BASE: "", PLOW_AGENT_TOKEN: "" });
  assert.equal(noEnv.status, 1);
  assert.match(noEnv.stderr, /PLOW_API_BASE/);
});

test("an iMessage email is a member like a phone, which is how an Android owner of an iPad is reached", async () => {
  seedRequest(home, { handle: "ana@example.com" });
  const calls: Call[] = [];
  const out = await startThread({ ...args, members: ["ana@example.com"], fetch: fakeFetch(() => new Response('{"uid":"chat_e"}', { status: 200 }), calls), base, token: "tok" });
  assert.deepEqual(out, { chatUid: "chat_e", messageSent: true });
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)).members, ["+5511999990000", "ana@example.com"]);
});

test("opens a group only for the saved open request and its own person, and never before the owner approves", async () => {
  const calls: Call[] = [];
  const fetch = fakeFetch(() => new Response('{"uid":"chat_9"}', { status: 201 }), calls);
  const go = (over: Record<string, unknown> = {}) => startThread({ ...args, fetch, base, token: "tok", ...over });
  await assert.rejects(go({ requestId: "r_missing" }), /not an open request/);
  await assert.rejects(go({ members: ["+15557654321"] }), /must be the request's person/);
  seedRequest(home, { status: "dropped" });
  await assert.rejects(go(), /not an open request/);
  seedRequest(home, { origin: "inbound", ownerApprovalAt: "2026-09-28T12:00:00.000Z" });
  await assert.rejects(go(), /waiting for the owner's approval/);
  assert.equal(calls.length, 0);
  // With the gate on, an inbound request that never got the pending marker is refused too: the config decides.
  writeFileSync(join(home, "config.json"), JSON.stringify({
    ownerName: "Jean", timezone: "America/Sao_Paulo", days: ["mon"], windowStart: "09:00", windowEnd: "18:00", durationMin: 30, horizonDays: 7,
    calendars: [{ account: "a@example.com", id: "a@example.com" }], defaultAccount: "a@example.com", setupDoneAt: "2026-09-28T12:00:00.000Z",
  }));
  seedRequest(home, { origin: "inbound" });
  await assert.rejects(go(), /not been approved by the owner/);
  assert.equal(calls.length, 0);
  seedRequest(home, { origin: "inbound", ownerApprovalAt: "2026-09-28T12:00:00.000Z", ownerApprovedAt: "2026-09-28T12:05:00.000Z" });
  assert.deepEqual(await go(), { chatUid: "chat_9", messageSent: true });
});
