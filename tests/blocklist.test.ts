import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { block, isBlocked, unblock } from "../skills/meetly/scripts/blocklist.ts";
import { startThread } from "../skills/meetly/scripts/start-thread.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, seedRequest, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-01T12:00:00Z");

test("a person is on the do-not-contact list however their number is written, and can be taken off", () => {
  let list = block([], ["+1 (555) 123-4567", "Ana@Example.com"], "Ana", T0);
  assert.deepEqual(list, [
    { handle: "+15551234567", name: "Ana", at: new Date(T0).toISOString() },
    { handle: "ana@example.com", name: "Ana", at: new Date(T0).toISOString() },
  ]);
  for (const h of ["+15551234567", "5551234567", "(555) 123-4567"]) assert.equal(isBlocked(list, h), true, h);
  assert.equal(isBlocked(list, "ANA@example.com"), true);
  assert.equal(isBlocked(list, "+15559999999"), false);
  // Blocking twice keeps one entry.
  assert.equal(block(list, ["5551234567"], "Ana", T0 + 1).length, 2);
  assert.deepEqual(unblock(list, ["(555) 123-4567", "ana@example.com"]), []);
  assert.throws(() => block([], [""], undefined, T0), /handle/);
});

test("the CLI blocks, checks, lists and unblocks", () => {
  const env = { MEETLY_HOME: tmpHome() };
  assert.deepEqual(cli("blocklist.ts", ["check", "--handle", "+15551234567"], env).json, { blocked: false });
  cli("blocklist.ts", ["block", "--handle", "+15551234567", "--handle", "ana@example.com", "--name", "Ana"], env);
  assert.deepEqual(cli("blocklist.ts", ["check", "--handle", "5551234567"], env).json, { blocked: true });
  assert.equal(cli("blocklist.ts", ["list"], env).json.blocked[0].name, "Ana");
  assert.deepEqual(cli("blocklist.ts", ["check", "--handle", "+15559999999", "--handle", "ana@example.com"], env).json, { blocked: true });
  cli("blocklist.ts", ["unblock", "--handle", "+15551234567", "--handle", "ana@example.com"], env);
  assert.deepEqual(cli("blocklist.ts", ["list"], env).json, { blocked: [] });
  assert.notEqual(cli("blocklist.ts", ["block"], env).status, 0);
});

test("a group is never opened with someone on the list, and nothing is posted", async () => {
  const home = tmpHome();
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  seedRequest(home);
  try {
    writeJson(join(home, "blocked.json"), [{ handle: "+15551234567", name: "Ana", at: new Date(T0).toISOString() }]);
    let calls = 0;
    const fetch = (async () => { calls++; return new Response("{}"); }) as typeof globalThis.fetch;
    await assert.rejects(
      startThread({ members: ["+15551234567"], body: "Hi", key: "k", requestId: "r_1", fetch, base: "https://api.plow.test/", token: "t" }),
      /do not contact/,
    );
    assert.equal(calls, 0);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("a block added while identity is being read stops the group-open POST", async () => {
  const home = tmpHome();
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  seedRequest(home);
  try {
    let calls = 0;
    const fetch = (async (url: string | URL | Request) => {
      calls++;
      if (String(url).endsWith("/v1/agents/me")) {
        writeJson(join(home, "blocked.json"), [{ handle: "+15551234567", name: "Ana", at: new Date(T0).toISOString() }]);
        return new Response(JSON.stringify({
          line: { uid: "line" },
          chats: [{ uid: "dm", status: "active", participants: [
            { type: "agent", relationship: "self", line: { uid: "line" } },
            { type: "member", role: "owner", provider_key: "+5511999990000" },
          ] }],
        }));
      }
      return new Response('{"uid":"unexpected"}', { status: 201 });
    }) as typeof globalThis.fetch;
    await assert.rejects(startThread({ members: ["+15551234567"], body: "Hi", key: "k", requestId: "r_1", fetch, base: "https://api.plow.test/", token: "t" }), /do not contact/);
    assert.equal(calls, 1);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});
