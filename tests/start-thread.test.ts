import { test } from "node:test";
import assert from "node:assert/strict";
import { startThread } from "../skills/meetly/scripts/start-thread.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "./helpers.ts";

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
const args = { members: ["+15551234567"], body: "Hi Ana, this is Meetly, Jean's assistant.", key: "rowid:42" };

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

test("the same key, people and text give the same idempotency key", async () => {
  const keys: string[] = [];
  const fetch = fakeFetch(() => new Response('{"uid":"c"}', { status: 200 }), []);
  const spy = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) keys.push(JSON.parse(String(init.body)).idempotency_key);
    return fetch(url, init);
  }) as typeof fetch;
  await startThread({ ...args, fetch: spy, base, token: "t" });
  await startThread({ ...args, fetch: spy, base, token: "t" });
  await startThread({ ...args, key: "rowid:43", fetch: spy, base, token: "t" });
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
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

test("the CLI needs a key and the Plow env", () => {
  const r = cli("start-thread.ts", ["--member", "+15551234567", "--body", "hi"], { PLOW_API_BASE: "http://127.0.0.1:9", PLOW_AGENT_TOKEN: "t" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--key/);
  const noEnv = cli("start-thread.ts", ["--member", "+15551234567", "--body", "hi", "--key", "k"], { PLOW_API_BASE: "", PLOW_AGENT_TOKEN: "" });
  assert.equal(noEnv.status, 1);
  assert.match(noEnv.stderr, /PLOW_API_BASE/);
});

test("an iMessage email is a member like a phone, which is how an Android owner of an iPad is reached", async () => {
  const calls: Call[] = [];
  const out = await startThread({ ...args, members: ["ana@example.com"], fetch: fakeFetch(() => new Response('{"uid":"chat_e"}', { status: 200 }), calls), base, token: "tok" });
  assert.deepEqual(out, { chatUid: "chat_e", messageSent: true });
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)).members, ["+5511999990000", "ana@example.com"]);
});

test("refuses a person whose inbound request still waits for the owner, and sends once it is approved", async () => {
  const home = mkdtempSync(join(tmpdir(), "meetly-"));
  const prior = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  try {
    const request = {
      id: "r_1", origin: "inbound", handle: "+15551234567", topic: "coffee", durationMin: 30, status: "offered",
      offered: [], offeredAt: "2026-09-28T12:00:00.000Z", createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z",
      ownerApprovalAt: "2026-09-28T12:00:00.000Z",
    };
    writeFileSync(join(home, "ledger.json"), JSON.stringify({ requests: [request] }));
    const calls: Call[] = [];
    const fetch = fakeFetch(() => new Response('{"uid":"chat_9"}', { status: 201 }), calls);
    await assert.rejects(startThread({ ...args, fetch, base, token: "tok" }), /waiting for the owner's approval/);
    assert.equal(calls.length, 0);
    writeFileSync(join(home, "ledger.json"), JSON.stringify({ requests: [{ ...request, ownerApprovedAt: "2026-09-28T12:05:00.000Z" }] }));
    assert.deepEqual(await startThread({ ...args, fetch, base, token: "tok" }), { chatUid: "chat_9", messageSent: true });
  } finally {
    if (prior === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = prior;
  }
});
