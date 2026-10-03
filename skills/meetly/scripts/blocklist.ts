// People Meetly must never contact: the owner said so. The list lives in
// blocked.json and is enforced where a group opens (start-thread.ts), so no
// route around the skill reaches them.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { normalizeHandle, sameHandle } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export type Blocked = { handle: string; at: string };

export const isBlocked = (list: Blocked[], handle: string): boolean => list.some((b) => sameHandle(b.handle, handle));

export function block(list: Blocked[], handles: string[], now: number): Blocked[] {
  if (handles.length === 0) throw new Error("give every phone and email for this contact");
  const at = new Date(now).toISOString();
  let result = list;
  for (const raw of handles) {
    const handle = normalizeHandle(raw ?? "");
    if (!handle || handle === "+") throw new Error("a handle is required: a phone or an email");
    if (!isBlocked(result, handle)) result = [...result, { handle, at }];
  }
  return result;
}

export const unblock = (list: Blocked[], handles: string[]): Blocked[] => {
  if (handles.length === 0) throw new Error("give every blocked phone and email");
  return list.filter((b) => !handles.some((handle) => sameHandle(b.handle, handle)));
};

export function loadBlocked(): Blocked[] {
  return readJson<Blocked[]>(file("blocked.json"), []);
}

// A writer waits longer than the 30 s POST that start-thread.ts holds this lock across.
const BLOCK_WAIT = { waitMs: 40_000 };

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { "handles-file": { type: "string" } } });
    // Contact-derived aliases never go on the command line: the agent writes a JSON array to a file.
    const handles = values["handles-file"] ? (JSON.parse(readFileSync(values["handles-file"], "utf8")) as string[]) : [];
    const path = file("blocked.json");
    switch (cmd) {
      case "block":
        if (!handles.length) throw new Error("usage: blocklist.ts block --handles-file F");
        return { blocked: updateJson<Blocked[]>(path, [], (l) => block(l, handles, Date.now()), BLOCK_WAIT) };
      case "unblock":
        if (!handles.length) throw new Error("usage: blocklist.ts unblock --handles-file F");
        return { blocked: updateJson<Blocked[]>(path, [], (l) => unblock(l, handles), BLOCK_WAIT) };
      case "check":
        if (!handles.length) throw new Error("usage: blocklist.ts check --handles-file F");
        return { blocked: handles.some((handle) => isBlocked(loadBlocked(), handle)) };
      case "list":
        return { blocked: loadBlocked() };
      default:
        throw new Error("usage: blocklist.ts block | unblock | check | list");
    }
  });
}
