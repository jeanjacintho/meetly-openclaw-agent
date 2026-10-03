// The owner's events in a range, for the owner's own request to cancel or move
// some of them: read on the Mac (busy.ts's listing), then cut down to the title,
// id, account, calendar and times the model needs to match the owner's words. Attendees,
// organizers, descriptions and links never reach the model.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { listEvents, stamp, type CalEvent } from "./busy.ts";
import { loadConfig, type Config } from "./config.ts";
import type { BridgeOptions } from "./mac.ts";

type OwnerEvent = { id: string; account: string; calendarId: string; title: string; start: string; end: string };

export function ownerEvents(events: CalEvent[]): OwnerEvent[] {
  const out: OwnerEvent[] = [];
  for (const e of events) {
    const start = stamp(e.startLocal, e.start);
    const end = stamp(e.endLocal, e.end);
    if (e.status === "cancelled" || !e.id || !e.account || !start || !end) continue;
    out.push({ id: e.id, account: e.account, calendarId: e.CalendarID || "primary", title: e.summary?.trim() || "(no title)", start, end });
  }
  return out;
}

export async function listOwnerEvents(
  config: Pick<Config, "calendars">,
  range: { from: string; to: string },
  opts: BridgeOptions = {},
): Promise<{ events: OwnerEvent[]; degraded: string[] }> {
  const { events, degraded, incomplete } = await listEvents(config, range, opts);
  // A listing cut short is not searched in full: report it like one that could not be read.
  return { events: ownerEvents(events), degraded: [...degraded, ...incomplete] };
}

if (isMain(import.meta.url)) {
  run(async () => {
    const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
    if (!values.from || !values.to) throw new Error("usage: owner-events.ts --from <ISO> --to <ISO>");
    return listOwnerEvents(loadConfig(), { from: values.from, to: values.to });
  });
}
