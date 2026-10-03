// Which of a person's handles Meetly can actually reach. The line sends over
// iMessage only, with no SMS fallback, and Plow reports a group message as
// "sent" whether or not it arrives: a phone that is not on iMessage (an
// Android, an RCS or SMS contact) silently gets nothing. The owner's own
// Messages archive knows which handle each person is on iMessage under, so
// this asks it, on the Mac, for the service of each handle (metadata only,
// never a message body) and picks the iMessage one used most recently.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";

const E164 = /^\+[1-9][0-9]{1,14}$/;
const EMAIL = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL.test(value);
}

export type HandleService = { handle: string; service: string; messages: number; lastAt: string | null };
export type Reachable =
  | { handle: string; via: "iMessage" }
  | { handle: null; reason: "not-on-imessage"; services: HandleService[] }
  | { handle: null; reason: "mac-unavailable" };

export function isHandle(h: string): boolean {
  return E164.test(h) || isEmailAddress(h);
}

// One row per handle and service: `id|service|count|last message (UTC)`.
export function serviceQuery(handles: string[]): string {
  const list = handles.map((h) => `'${h.toLowerCase().replaceAll("'", "''")}'`).join(", ");
  return "select h.id, h.service, count(m.ROWID), " +
    "coalesce(datetime(max(m.date) / 1000000000 + 978307200, 'unixepoch'), '') " +
    `from handle h left join message m on m.handle_id = h.ROWID where lower(h.id) in (${list}) group by h.id, h.service;`;
}

export function parseServices(output: string): HandleService[] {
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [handle = "", service = "", count = "0", last = ""] = line.split("|");
    return { handle, service, messages: Number(count) || 0, lastAt: last || null };
  });
}

/** The iMessage handle with the latest message; a handle on iMessage but never written to still counts. */
export function pickReachable(services: HandleService[]): string | undefined {
  const imessage = services.filter((s) => s.service === "iMessage");
  imessage.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || b.messages - a.messages);
  return imessage[0]?.handle;
}

export async function reachableHandle(handles: string[], opts: BridgeOptions = {}): Promise<Reachable> {
  if (handles.length === 0) throw new Error("give at least one handle (a JSON array of +E164 phones and emails)");
  for (const h of handles) if (!isHandle(h)) throw new Error(`not a phone in E.164 (like +15551234567) or an email: ${h}`);
  const output = await runOnMac({
    argv: ["/bin/sh", "-c", 'exec /usr/bin/sqlite3 -readonly -separator "|" "$HOME/Library/Messages/chat.db" "$1"', "sh", serviceQuery(handles)],
    readPaths: ["~/Library/Messages"],
    goal: "Meetly: check which of this contact's phone numbers and emails you reach over iMessage (no message contents)",
  }, opts).catch(() => undefined);
  if (output === undefined) return { handle: null, reason: "mac-unavailable" };
  const services = parseServices(output);
  const handle = pickReachable(services);
  return handle ? { handle, via: "iMessage" } : { handle: null, reason: "not-on-imessage", services };
}

if (isMain(import.meta.url)) {
  run(() => {
    // Contact text never goes on the command line: the handles come from a JSON array file.
    const { values } = parseArgs({ options: { "handles-file": { type: "string" } } });
    if (!values["handles-file"]) throw new Error("usage: reachable-handle.ts --handles-file F (a JSON array of phones and emails)");
    return reachableHandle(JSON.parse(readFileSync(values["handles-file"], "utf8")) as string[]);
  });
}
