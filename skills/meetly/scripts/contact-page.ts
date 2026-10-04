// One page per person Meetly has scheduled with: where they stand, the exact
// holds on the calendar, what was proposed, the next step, and a dated log.
// The page is derived from the ledger and the do-not-contact list, never
// edited by hand, so it changes only when they do (after the calendar or the
// group confirmed it). It is what to read before proposing to someone again:
// how they met before, and what is still open.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { isBlocked, loadBlocked, type Blocked } from "./blocklist.ts";
import { loadConfig } from "./config.ts";
import { holdRefs, normalizeHandle, sameHandle, stageOf, nextStepFor, type HoldRef, type Ledger, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";

export type Page = { handle: string; name?: string; status: string; path: string; markdown: string };

const slug = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The page's file: the person's name for reading, plus a short hash of the handle so two people never share one. */
export function pagePath(handle: string, name?: string): string {
  const id = createHash("sha256").update(normalizeHandle(handle)).digest("hex").slice(0, 6);
  return file(`pages/${slug(name ?? "") || "contact"}-${id}.md`);
}

// A request's live calendar entries: the offered holds and their travel blocks, a staged offer's, an out-of-hours
// time's buffers, or the booked event and its buffers.
function liveHolds(r: Request): HoldRef[] {
  if (r.status === "booked") return [...(r.eventId && r.booked ? [{ holdId: r.eventId, account: r.booked.account }] : []), ...(r.booked?.travel ?? [])];
  if (r.status !== "offered") return [];
  return [...holdRefs(r.offered), ...holdRefs(r.pendingOffer?.offered ?? []), ...(r.pendingOwner?.travel ?? [])];
}

export function renderPage(ledger: Ledger, handle: string, blocked: Blocked[], now: number, timezone = "UTC"): Page {
  const requests = ledger.requests.filter((r) => sameHandle(r.handle, handle)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const name = requests.findLast((r) => r.name)?.name;
  const current = requests.findLast((r) => r.status === "offered") ?? requests.findLast((r) => r.status === "booked" && (!r.booked || Date.parse(r.booked.end) >= now)) ?? requests.at(-1);
  const blockedNow = isBlocked(blocked, handle);
  const status = blockedNow ? "do_not_contact" : current ? stageOf(current, now) : "new";
  const nextStep = blockedNow ? "none: the owner said never to contact them" : current ? nextStepFor(current, now) : "none";
  const when = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const at = (iso: string) => when.format(new Date(iso));
  const lines = [
    `# ${name ?? normalizeHandle(handle)}`,
    "",
    `- handle: ${normalizeHandle(handle)}`,
    `- status: ${status}`,
    `- next_step: ${nextStep}`,
  ];
  if (current) {
    lines.push(`- request: ${current.id} (${current.topic}; ${current.format ?? "unknown"}${current.location ? ` at ${current.location}` : ""}; ${current.durationMin} min)`);
    const holds = liveHolds(current);
    lines.push(`- holds: ${holds.length ? holds.map((h) => `${h.holdId} (${h.account})`).join(", ") : "none"}`);
    const proposed = current.status === "offered" ? current.offered : [];
    lines.push(`- proposed: ${proposed.length ? proposed.map((o) => at(o.start)).join("; ") : "none"}`);
    if (current.booked) lines.push(`- booked: ${at(current.booked.start)}`);
  }
  lines.push("", "## Meetings", "");
  if (requests.length === 0) lines.push("None yet.");
  for (const r of [...requests].reverse()) {
    const how = [r.format ?? "unknown", r.location, `${r.durationMin} min`].filter(Boolean).join(", ");
    lines.push(`- ${r.createdAt.slice(0, 10)}: ${r.topic} (${how}): ${r.status}${r.booked ? ` for ${at(r.booked.start)}` : ""}`);
  }
  const log = requests.flatMap((r) => (r.log ?? []).map((e) => ({ ...e, topic: r.topic }))).sort((a, b) => a.at.localeCompare(b.at));
  lines.push("", "## Log", "");
  if (log.length === 0) lines.push("Nothing logged yet.");
  for (const e of log) lines.push(`- ${at(e.at)} (${e.topic}): ${e.text}`);
  const page: Page = { handle: normalizeHandle(handle), status, path: pagePath(handle, name), markdown: lines.join("\n") + "\n" };
  if (name !== undefined) page.name = name;
  return page;
}

// Written whole and renamed into place, so a reader never sees half a page.
function write(page: Page): void {
  mkdirSync(dirname(page.path), { recursive: true });
  let old: string | undefined;
  try {
    old = readFileSync(page.path, "utf8");
  } catch {
    old = undefined;
  }
  if (old === page.markdown) return;
  writeFileSync(`${page.path}.tmp`, page.markdown);
  renameSync(`${page.path}.tmp`, page.path);
}

function timezone(): string {
  try {
    return loadConfig().timezone;
  } catch {
    return "UTC";
  }
}

/** Every person in the ledger or on the do-not-contact list gets a current page. */
export function writeAll(now: number = Date.now()): Page[] {
  const ledger = readJson<Ledger>(file("ledger.json"), { requests: [] });
  const blocked = loadBlocked();
  const people: string[] = [];
  for (const h of [...ledger.requests.map((r) => r.handle), ...blocked.map((b) => b.handle)]) {
    if (!people.some((p) => sameHandle(p, h))) people.push(h);
  }
  const tz = timezone();
  const pages = people.map((h) => renderPage(ledger, h, blocked, now, tz));
  for (const p of pages) write(p);
  return pages;
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({ options: { "handles-file": { type: "string" }, all: { type: "boolean" } } });
    if (values.all) return { pages: writeAll().map(({ name, status, path }) => ({ name: name ?? null, status, path })) };
    if (!values["handles-file"]) throw new Error("usage: contact-page.ts --handles-file F (a JSON array with the one handle) | --all");
    // A handle came from a message or a contact card, so it arrives in a file, never on the command line.
    const handle = (JSON.parse(readFileSync(values["handles-file"], "utf8")) as string[])[0];
    if (!handle) throw new Error("the handles file is empty");
    const page = renderPage(readJson<Ledger>(file("ledger.json"), { requests: [] }), handle, loadBlocked(), Date.now(), timezone());
    write(page);
    return page;
  });
}
