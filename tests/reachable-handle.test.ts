import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmailAddress, isHandle, parseServices, pickReachable, reachableHandle, serviceQuery } from "../skills/meetly/scripts/reachable-handle.ts";

test("a handle is a phone in E.164 or an email", () => {
  assert.equal(isEmailAddress("person@example.com"), true);
  assert.equal(isEmailAddress("bad email@example.com"), false);
  for (const h of ["+5511999990000", "ana@example.com"]) assert.equal(isHandle(h), true, h);
  for (const h of ["11 99999-0000", "ana", "a@b", "x' or 1=1 --@a.b"]) assert.equal(isHandle(h), false, h);
});

test("the query asks for each handle's service, never a message body, and quotes handles", () => {
  const q = serviceQuery(["+5511999990000", "Ana@Example.com"]);
  assert.match(q, /select h\.id, h\.service, count\(m\.ROWID\)/);
  assert.match(q, /where lower\(h\.id\) in \('\+5511999990000', 'ana@example\.com'\)/);
  assert.doesNotMatch(q, /text|attributedBody/);
});

test("the iMessage handle written to most recently wins; RCS and SMS never do", () => {
  const services = parseServices([
    "+5511999990000|RCS|0|",
    "+5511999990000|SMS|12|2026-09-26 10:00:00",
    "ana@example.com|iMessage|4|2026-09-25 19:36:46",
    "ana@work.com|iMessage|9|2026-01-02 08:00:00",
  ].join("\n") + "\n");
  assert.deepEqual(services[0], { handle: "+5511999990000", service: "RCS", messages: 0, lastAt: null });
  assert.equal(pickReachable(services), "ana@example.com");
  assert.equal(pickReachable(parseServices("+5511999990000|RCS|0|\n")), undefined);
});

type Seen = { init: RequestInit | undefined };
function bridge(output: string, seen: Seen[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ init });
    const result = { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output, status: "completed" }) }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`);
  }) as typeof fetch;
}

test("an Android phone next to an iMessage email: the email is the handle to reach", async () => {
  const seen: Seen[] = [];
  const out = await reachableHandle(["+5511999990000", "ana@example.com"],
    { token: "tok", fetch: bridge("+5511999990000|RCS|0|\nana@example.com|iMessage|4|2026-09-25 19:36:46\n", seen) });
  assert.deepEqual(out, { handle: "ana@example.com", via: "iMessage" });
  const args = JSON.parse(String(seen[0]!.init?.body)).params.arguments;
  assert.deepEqual(args.read_paths, ["~/Library/Messages"]);
  assert.equal(args.argv[0], "/bin/sh");
  assert.match(args.argv[2], /sqlite3 -readonly/);
});

test("no iMessage handle, or no Mac, is said rather than guessed", async () => {
  const none = await reachableHandle(["+5511999990000"], { token: "tok", fetch: bridge("+5511999990000|RCS|0|\n") });
  assert.equal(none.handle, null);
  assert.equal(none.handle === null && none.reason, "not-on-imessage");
  assert.deepEqual(await reachableHandle(["+5511999990000"], { token: "" }), { handle: null, reason: "mac-unavailable" });
  await assert.rejects(reachableHandle(["not a handle"], { token: "tok" }), /E\.164.*or an email/);
});
