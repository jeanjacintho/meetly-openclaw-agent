import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { pagePath, renderPage } from "../skills/meetly/scripts/contact-page.ts";
import type { Ledger, Request } from "../skills/meetly/scripts/ledger.ts";
import { cli, handlesFile, tmpHome, writeConfig } from "./helpers.ts";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;
const ANA = "+15551234567";
const at = (ms: number) => new Date(ms).toISOString();
const request = (over: Partial<Request>): Request => ({
  id: "r_1", origin: "owner", handle: ANA, name: "Ana Lima", topic: "coffee", durationMin: 30, status: "offered", format: "meet",
  offered: [{ start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T13:30:00.000Z", holdId: "h1", account: "jean@example.com" }],
  offeredAt: at(T0), createdAt: at(T0), updatedAt: at(T0), ...over,
});

test("the page says where the person stands, the exact holds, what was proposed and the next step", () => {
  const ledger: Ledger = { requests: [
    request({ id: "r_0", topic: "intro call", format: "phone", status: "booked", eventId: "ev_9", createdAt: at(T0 - 30 * 24 * HOUR),
      booked: { start: "2026-09-02T13:00:00.000Z", end: "2026-09-02T13:30:00.000Z", account: "jean@example.com" },
      log: [{ at: at(T0 - 29 * 24 * HOUR), text: "booked the intro call" }] }),
    request({ chatUid: "g1", log: [{ at: at(T0 + HOUR), text: "offered three times" }],
      offered: [{ start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T13:30:00.000Z", holdId: "h1", account: "jean@example.com",
        travel: [{ holdId: "t1", account: "jean@example.com" }] }] }),
  ] };
  const page = renderPage(ledger, "+15551234567", [], T0 + 2 * HOUR, "America/Sao_Paulo");
  assert.equal(page.status, "sent");
  assert.equal(page.name, "Ana Lima");
  assert.match(page.markdown, /^# Ana Lima\n/);
  assert.match(page.markdown, /- status: sent\n/);
  assert.match(page.markdown, /- next_step: wait for their answer\n/);
  assert.match(page.markdown, /- holds: h1 \(jean@example\.com\), t1 \(jean@example\.com\)\n/);
  assert.match(page.markdown, /- proposed: Mon, Oct 5, 2026, 10:00\n/, "in the owner's time zone");
  // Earlier meetings, newest first, keep how they met: what to read before proposing again.
  const meetings = page.markdown.split("## Meetings")[1]!.split("## Log")[0]!;
  assert.ok(meetings.indexOf("coffee (meet, 30 min)") < meetings.indexOf("intro call (phone, 30 min): booked"));
  assert.match(page.markdown, /\(intro call\): booked the intro call\n- .*\(coffee\): offered three times\n$/);
});

test("a person waiting on the owner, one who was never contacted, and one on the do-not-contact list", () => {
  const gated = renderPage({ requests: [request({ ownerApprovalAt: at(T0) })] }, ANA, [], T0, "UTC");
  assert.equal(gated.status, "waiting_on_us");
  assert.match(gated.markdown, /next_step: owner decision needed/);
  const nobody = renderPage({ requests: [] }, "+15559990000", [], T0, "UTC");
  assert.equal(nobody.status, "new");
  assert.match(nobody.markdown, /None yet\./);
  const blocked = renderPage({ requests: [request({ status: "dropped" })] }, ANA, [{ handle: ANA, at: at(T0) }], T0, "UTC");
  assert.equal(blocked.status, "do_not_contact");
  assert.match(blocked.markdown, /next_step: none: the owner said never to contact them/);
  assert.match(blocked.markdown, /- holds: none\n/, "a closed request holds nothing");
  // Blocked under its E.164 form, the same person's local form is blocked too, as the block itself is enforced.
  assert.equal(renderPage({ requests: [request({ handle: "5551234567" })] }, "5551234567", [{ handle: ANA, at: at(T0) }], T0, "UTC").status, "do_not_contact");
});

test("a page belongs to one handle exactly: its file never follows a name, and a similar number is someone else", () => {
  assert.notEqual(pagePath(ANA), pagePath("+15550001111"));
  assert.equal(pagePath("+1 555 123 4567"), pagePath(ANA));
  assert.match(pagePath(ANA), /pages\/[0-9a-f]{12}\.md$/);
  // A local number sharing Ana's last digits is another person: neither page shows the other's meetings.
  const ledger: Ledger = { requests: [request({}), request({ id: "r_2", handle: "5551234567", name: "Other", topic: "secret" })] };
  assert.doesNotMatch(renderPage(ledger, ANA, [], T0, "UTC").markdown, /secret/);
  assert.doesNotMatch(renderPage(ledger, "5551234567", [], T0, "UTC").markdown, /coffee/);
});

test("the CLI writes one page, or every page, under the state directory", () => {
  const home = tmpHome();
  writeConfig(home);
  writeFileSync(join(home, "ledger.json"), JSON.stringify({ requests: [request({}), request({ id: "r_2", handle: "+15550001111", name: "Bia" })] }));
  writeFileSync(join(home, "blocked.json"), JSON.stringify([{ handle: "+15552220000", at: at(T0) }]));
  const env = { MEETLY_HOME: home };
  const one = cli("contact-page.ts", ["--handles-file", handlesFile(ANA)], env);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(readFileSync(one.json.path, "utf8"), one.json.markdown);
  // Private: only Meetly's user reads a person's history.
  assert.equal(statSync(one.json.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(one.json.path)).mode & 0o777, 0o700);
  const all = cli("contact-page.ts", ["--all"], env);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(all.json.pages.map((p: { name: string | null; status: string }) => [p.name, p.status]),
    [["Ana Lima", "delivery_unknown"], ["Bia", "delivery_unknown"], [null, "do_not_contact"]]);
  for (const p of all.json.pages) assert.ok(existsSync(p.path), p.path);
  assert.match(cli("contact-page.ts", [], env).stderr, /usage/);
});
