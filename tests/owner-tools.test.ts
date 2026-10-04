import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isOwnerDm, registerOwnerTools } from "../plugin/owner-tools.js";
import { startThread } from "../skills/meetly/scripts/start-thread.ts";
import { cli, seedRequest, tmpHome, writeConfig } from "./helpers.ts";

const SCRIPTS = resolve(import.meta.dirname, "..", "skills", "meetly", "scripts");
const load = (name: string) => import(join(SCRIPTS, name));

// The turns as the runtime hands them to a plugin tool.
const OWNER_DM = { sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true, requesterSenderId: "plow-owner" };
const POLL = { sessionKey: "agent:main:cron:meetly-poll", agentId: "main" };
const GUEST_IN_GROUP = { sessionKey: "agent:main:plow:group:cht_g", messageChannel: "plow", agentAccountId: "chat", senderIsOwner: false, requesterSenderId: "+15551234567" };

type Tool = { name: string; execute: (id: string, args: object) => Promise<{ isError: boolean; details: any }> };
function tools(context: object): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  registerOwnerTools({ registerTool: (factory: (ctx: object) => Tool) => { const t = factory(context); out[t.name] = t; } }, load);
  return out;
}

let home = "";
let prior: string | undefined;
beforeEach(() => { prior = process.env.MEETLY_HOME; home = tmpHome(); process.env.MEETLY_HOME = home; writeConfig(home); });
afterEach(() => { if (prior === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = prior; });

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
function plow(posts: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/v1/agents/me")) return new Response(JSON.stringify(identity), { status: 200 });
    posts.push(String(init?.body));
    return new Response('{"uid":"chat_new"}', { status: 201 });
  }) as typeof fetch;
}
const open = (requestId: string, posts: string[]) => startThread({
  members: ["+15551234567"], body: "Hi Ana, this is Meetly.", requestId, fetch: plow(posts), base: "https://api.plow.test/", token: "t",
});
const ledger = () => JSON.parse(readFileSync(join(home, "ledger.json"), "utf8")).requests;

test("only the owner's own Plow DM, as the runtime reports it, is the owner's turn", () => {
  assert.equal(isOwnerDm(OWNER_DM), true);
  for (const ctx of [
    POLL,
    GUEST_IN_GROUP,
    { ...GUEST_IN_GROUP, senderIsOwner: true },
    { ...OWNER_DM, senderIsOwner: undefined },
    { ...OWNER_DM, agentAccountId: "email" },
    { ...OWNER_DM, messageChannel: "webchat" },
    {},
    undefined,
  ]) assert.equal(isOwnerDm(ctx), false, JSON.stringify(ctx));
});

test("a poll turn cannot reach a guest without the owner's approval, whatever origin it writes", async () => {
  // A guest's text drove the poll turn: it saves a request claiming the owner asked.
  const offer = { start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T13:30:00.000Z", holdId: "h1", account: "a@example.com" };
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify({
    origin: "owner", handle: "+15551234567", name: "Ana", topic: "coffee", durationMin: 30, offered: [offer],
  })], { MEETLY_HOME: home });
  assert.equal(saved.status, 0, saved.stderr);
  const id = saved.json.request.id;
  assert.equal(typeof saved.json.request.ownerApprovalAt, "string", "gated although the payload says owner");

  const posts: string[] = [];
  await assert.rejects(open(id, posts), /waiting for the owner's approval/);
  // Neither the script nor the tool approves from the poll, or from a guest in a group.
  assert.equal(cli("ledger.ts", ["approve", "--id", id], { MEETLY_HOME: home }).status, 1);
  for (const ctx of [POLL, GUEST_IN_GROUP]) {
    const out = await tools(ctx).meetly_approve_request!.execute("call", { id });
    assert.equal(out.isError, true);
    assert.match(out.details.error, /Only the owner/);
  }
  assert.equal(ledger()[0].ownerApprovedAt, undefined);
  await assert.rejects(open(id, posts), /waiting for the owner's approval/);
  assert.deepEqual(posts, [], "nothing reached the guest");

  // The owner says yes in their DM: the group opens.
  const yes = await tools(OWNER_DM).meetly_approve_request!.execute("call", { id });
  assert.deepEqual([yes.isError, yes.details.approved], [false, true]);
  assert.deepEqual(await open(id, posts), { chatUid: "chat_new", messageSent: true });
  assert.equal(posts.length, 1);
  // A second yes changes nothing.
  assert.equal((await tools(OWNER_DM).meetly_approve_request!.execute("call", { id })).details.approved, false);
});

test("a request added with a chat never opens a new group, so a made-up chat cannot skip the gate", async () => {
  seedRequest(home, { chatUid: "made-up" });
  const posts: string[] = [];
  await assert.rejects(open("r_1", posts), /already has a group/);
  assert.deepEqual(posts, []);
});

test("only the owner's own DM turns approval off", async () => {
  for (const ctx of [POLL, GUEST_IN_GROUP]) {
    const out = await tools(ctx).meetly_set_owner_gate!.execute("call", { on: false });
    assert.equal(out.isError, true);
  }
  assert.equal(cli("record-setup.ts", ["--field", "ownerGate", "--value", "off"], { MEETLY_HOME: home }).status, 1);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).ownerGate, undefined, "still the default, on");
  const off = await tools(OWNER_DM).meetly_set_owner_gate!.execute("call", { on: false });
  assert.equal(off.isError, false);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).ownerGate, false);
  // Turning it back on is always allowed: it only adds a question.
  assert.equal(cli("record-setup.ts", ["--field", "ownerGate", "--value", "on"], { MEETLY_HOME: home }).status, 0);
});
