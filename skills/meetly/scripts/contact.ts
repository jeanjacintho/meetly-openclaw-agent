// Who wrote from a handle, per the owner's Contacts on the Mac: the card's
// name, phones and emails, read-only across every AddressBook store (the root
// one and one per sync source), in one Mac call. Never a note or an address.
// A handle with no card is not an error: the request goes on with the handle.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";
import { isHandle } from "./reachable-handle.ts";

export type Person = { name: string | null; phones: string[]; emails: string[] };
export type Lookup =
  | { found: true; handle: string; name: string | null; phones: string[]; emails: string[]; matches: number }
  | { found: false; handle: string; reason?: "mac-unavailable" };

const digits = (s: string) => s.replace(/\D/g, "");
const STRIPPED = "replace(replace(replace(replace(replace(replace(p.ZFULLNUMBER, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')";

// Lines `R|id|first|last|org`, `P|id|number`, `E|id|email` for each card with
// the handle; the digits filter is loose, parseContacts makes it exact.
export function contactQuery(handle: string): string {
  if (!isHandle(handle)) throw new Error(`not a phone in E.164 (like +15551234567) or an email: ${handle}`);
  const phone = handle.startsWith("+") ? digits(handle).slice(-8) : "";
  const email = phone ? "" : handle.toLowerCase().replaceAll("'", "''");
  const match = phone
    ? `select p.ZOWNER from ZABCDPHONENUMBER p where ${STRIPPED} like '%${phone}'`
    : `select e.ZOWNER from ZABCDEMAILADDRESS e where lower(e.ZADDRESS) = '${email}'`;
  return `with m as (${match}) ` +
    "select 'R', r.Z_PK, coalesce(r.ZFIRSTNAME, ''), coalesce(r.ZLASTNAME, ''), coalesce(r.ZORGANIZATION, '') from ZABCDRECORD r where r.Z_PK in m " +
    "union all select 'P', p.ZOWNER, p.ZFULLNUMBER, '', '' from ZABCDPHONENUMBER p where p.ZOWNER in m " +
    "union all select 'E', e.ZOWNER, e.ZADDRESS, '', '' from ZABCDEMAILADDRESS e where e.ZOWNER in m;";
}

function samePhone(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  return Math.min(x.length, y.length) >= 8 && (x.endsWith(y) || y.endsWith(x));
}

// The cards in the output (`S|n` starts store n) that really carry the handle.
export function parseContacts(output: string, handle: string): Person[] {
  const cards = new Map<string, Person>();
  let store = "";
  for (const line of output.split("\n")) {
    const [kind, id = "", a = "", b = "", c = ""] = line.trim().split("|");
    if (kind === "S") store = id;
    const key = `${store}:${id}`;
    if (kind === "R") cards.set(key, { name: [a, b].filter(Boolean).join(" ") || c || null, phones: [], emails: [] });
    if (kind === "P") cards.get(key)?.phones.push(a);
    if (kind === "E") cards.get(key)?.emails.push(a);
  }
  const wanted = handle.toLowerCase();
  return [...cards.values()].filter((p) =>
    handle.startsWith("+") ? p.phones.some((n) => samePhone(n, handle)) : p.emails.some((e) => e.toLowerCase() === wanted));
}

export async function lookupContact(handle: string, opts: BridgeOptions = {}): Promise<Lookup> {
  const query = contactQuery(handle);
  const output = await runOnMac({
    argv: ["/bin/sh", "-c",
      'i=0; /usr/bin/find "$HOME/Library/Application Support/AddressBook" -maxdepth 4 -name "AddressBook*.abcddb" | ' +
      'while IFS= read -r db; do echo "S|$i"; i=$((i+1)); /usr/bin/sqlite3 -readonly -separator "|" "$db" "$1" 2>/dev/null; done',
      "sh", query],
    readPaths: ["~/Library/Application Support/AddressBook"],
    goal: "Meetly: find the contact who asked to meet, by the number or email they wrote from (name, phones and emails only)",
    timeoutMs: 30_000,
  }, opts).catch(() => undefined);
  if (output === undefined) return { found: false, handle, reason: "mac-unavailable" };
  const people = parseContacts(output, handle);
  const first = people[0];
  if (!first) return { found: false, handle };
  return { found: true, handle, name: first.name, phones: first.phones, emails: first.emails, matches: people.length };
}

if (isMain(import.meta.url)) {
  run(() => {
    // The handle came from a message: it goes in a one-element JSON array file, never on the command line.
    const { values } = parseArgs({ options: { "handles-file": { type: "string" } } });
    if (!values["handles-file"]) throw new Error("usage: contact.ts --handles-file F (a JSON array with the one phone or email)");
    const [handle] = JSON.parse(readFileSync(values["handles-file"], "utf8")) as string[];
    if (!handle) throw new Error("the handles file is empty");
    return lookupContact(handle);
  });
}
