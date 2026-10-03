import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { block, isBlocked, unblock } from "../skills/meetly/scripts/blocklist.ts";
import { startThread } from "../skills/meetly/scripts/start-thread.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-01T12:00:00Z");

test("a person is on the do-not-contact list however their number is written, and can be taken off", () => {
  let list = block([], ["+1 (555) 123-4567", "Ana@Example.com"], T0);
  assert.deepEqual(list, [
    { handle: "+15551234567", at: new Date(T0).toISOString() },
    { handle: "ana@example.com", at: new Date(T0).toISOString() },
  ]);
  for (const h of ["+15551234567", "5551234567", "(555) 123-4567"]) assert.equal(isBlocked(list, h), true, h);
  assert.equal(isBlocked(list, "ANA@example.com"), true);
  assert.equal(isBlocked(list, "+15559999999"), false);
  // Blocking twice keeps one entry.
  assert.equal(block(list, ["5551234567"], T0 + 1).length, 2);
  assert.deepEqual(unblock(list, ["(555) 123-4567", "ana@example.com"]), []);
  // Two different full international numbers that share their last digits are two people: blocking one never covers or lifts the other.
  const intl = block([], ["+15551234567", "+9915551234567"], T0);
  assert.equal(intl.length, 2);
  assert.equal(unblock(intl, ["+15551234567"]).length, 1);
  assert.equal(isBlocked(unblock(intl, ["+15551234567"]), "+15551234567"), false);
  assert.throws(() => block([], [""], T0), /handle/);
});

test("the CLI blocks, checks, lists and unblocks from a handles file, never the command line", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const filed = (name: string, handles: string[]) => {
    const path = join(env.MEETLY_HOME, name);
    writeFileSync(path, JSON.stringify(handles));
    return path;
  };
  const ana = filed("ana.json", ["+15551234567", "ana@example.com"]);
  const payload = filed("payload.json", ["+15559990000", "x@example.com; touch pwned"]);
  assert.deepEqual(cli("blocklist.ts", ["check", "--handles-file", ana], env).json, { blocked: false });
  cli("blocklist.ts", ["block", "--handles-file", ana], env);
  assert.deepEqual(cli("blocklist.ts", ["check", "--handles-file", filed("n.json", ["5551234567"])], env).json, { blocked: true });
  assert.deepEqual(cli("blocklist.ts", ["check", "--handles-file", filed("m.json", ["+15559999999", "ana@example.com"])], env).json, { blocked: true });
  assert.equal(cli("blocklist.ts", ["block", "--handles-file", payload], env).status, 0);
  assert.deepEqual(cli("blocklist.ts", ["check", "--handles-file", payload], env).json, { blocked: true });
  cli("blocklist.ts", ["unblock", "--handles-file", payload], env);
  cli("blocklist.ts", ["unblock", "--handles-file", ana], env);
  assert.deepEqual(cli("blocklist.ts", ["list"], env).json, { blocked: [] });
  assert.notEqual(cli("blocklist.ts", ["block"], env).status, 0);
});

test("a group is never opened with someone on the list, and nothing is posted", async () => {
  const home = tmpHome();
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  try {
    writeJson(join(home, "blocked.json"), [{ handle: "+15551234567", at: new Date(T0).toISOString() }]);
    let calls = 0;
    const fetch = (async () => { calls++; return new Response("{}"); }) as typeof globalThis.fetch;
    await assert.rejects(
      startThread({ members: ["+15551234567"], body: "Hi", key: "k", fetch, base: "https://api.plow.test/", token: "t" }),
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
  try {
    let calls = 0;
    const fetch = (async (url: string | URL | Request) => {
      calls++;
      if (String(url).endsWith("/v1/agents/me")) {
        writeJson(join(home, "blocked.json"), [{ handle: "+15551234567", at: new Date(T0).toISOString() }]);
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
    await assert.rejects(startThread({ members: ["+15551234567"], body: "Hi", key: "k", fetch, base: "https://api.plow.test/", token: "t" }), /do not contact/);
    assert.equal(calls, 1);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("a block issued during a slow opener waits for the POST instead of failing", async () => {
  const home = tmpHome();
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  try {
    const aliases = join(home, "ana.json");
    writeFileSync(aliases, JSON.stringify(["+15551234567"]));
    const events: string[] = [];
    let child: Promise<number | null> | undefined;
    const fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/agents/me")) {
        return new Response(JSON.stringify({ line: { uid: "l" }, chats: [{ uid: "dm", status: "active", participants: [
          { type: "agent", relationship: "self", line: { uid: "l" } }, { type: "member", role: "owner", provider_key: "+5511999990000" }] }] }));
      }
      // The block starts while the POST holds the lock, and must outlast the old 10 s wait's worth of patience.
      child = new Promise((resolve) => {
        const proc = spawn(process.execPath, [join(import.meta.dirname, "..", "skills", "meetly", "scripts", "blocklist.ts"), "block", "--handles-file", aliases], { env: { ...process.env, MEETLY_HOME: home } });
        proc.on("close", (code) => { events.push("block"); resolve(code); });
      });
      await new Promise((r) => setTimeout(r, 1500));
      events.push("post");
      return new Response('{"uid":"c1"}');
    }) as typeof globalThis.fetch;
    await startThread({ members: ["+15551234567"], body: "Hi", key: "request:r_1", fetch, base: "https://api.plow.test/", token: "t" });
    assert.equal(await child, 0);
    assert.deepEqual(events, ["post", "block"]);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});
