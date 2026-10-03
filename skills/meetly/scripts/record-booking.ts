// Records a booked event in the ledger from plow-gog's own output, so the
// event id, its time and its Meet link are copied, never retyped. Run after
// every create or update that books a request or changes its format.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import type { Config } from "./config.ts";
import { readEvent, type EventInfo } from "./event.ts";
import { updateRequest, type Ledger, type Patch, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export type Recorded = { ledger: Ledger; meetUrl: string | null; warning?: "no-meet-link" };

// `room` is the owner's Zoom room from their configuration: when it is set, a
// video meeting keeps it as its link instead of a Google Meet one.
export function recordBooking(ledger: Ledger, id: string, event: EventInfo, account: string, now: number, room?: string): Recorded {
  const request = ledger.requests.find((r) => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  if (request.status !== "offered" && request.status !== "booked") throw new Error(`request ${id} is ${request.status}, not open`);
  if (request.status === "booked" && request.eventId !== undefined && request.eventId !== event.id) {
    throw new Error(`request ${id} is already booked as ${request.eventId}, not ${event.id}`);
  }
  if (event.status === "cancelled") throw new Error(`event ${event.id} is cancelled`);
  if (!account) throw new Error("--account is required: the Google account the event is on");
  const isMeet = request.format === "meet";
  const patch: Patch = {
    status: "booked",
    eventId: event.id,
    booked: { start: event.start, end: event.end, account },
    meetUrl: isMeet && !room ? event.meetUrl : null,
    roomUrl: isMeet && room ? room : null,
    pendingOwner: null,
  };
  // A reminder belongs to one start time: a moved meeting gets a new one.
  if (request.booked && Date.parse(request.booked.start) !== Date.parse(event.start)) patch.reminder = null;
  const next = updateRequest(ledger, id, patch, now);
  const meetUrl = (next.requests.find((r) => r.id === id) as Request).meetUrl ?? null;
  return { ledger: next, meetUrl, ...(isMeet && !room && !meetUrl ? { warning: "no-meet-link" as const } : {}) };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({ options: { id: { type: "string" }, "event-file": { type: "string" }, account: { type: "string" } } });
    if (!values.id || !values["event-file"] || values.account === undefined) {
      throw new Error("usage: record-booking.ts --id X --event-file F --account A");
    }
    const event = readEvent(values["event-file"]);
    let result: Recorded | undefined;
    updateJson<Ledger>(file("ledger.json"), { requests: [] }, (l) => {
      result = recordBooking(l, values.id!, event, values.account!, Date.now(), readJson<Config | null>(file("config.json"), null)?.zoomRoomUrl);
      return result.ledger;
    });
    const { ledger, ...rest } = result!;
    return { request: ledger.requests.find((r) => r.id === values.id), ...rest };
  });
}
