// Records a booked event in the ledger from plow-gog's own output, so the
// event id, its time and its Meet link are copied, never retyped. Run after
// every create or update that books a request or changes its format.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { readEvent, type EventInfo } from "./event.ts";
import { updateRequest, type Ledger, type Patch, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { updateJson } from "./store.ts";

export type Recorded = { ledger: Ledger; meetUrl: string | null; warning?: "no-meet-link" };

// The event is the one snapshot: a video meeting keeps the Zoom room that the
// event's own location shows (the owner's room), else the event's Meet link.
export function recordBooking(ledger: Ledger, id: string, event: EventInfo, account: string, now: number): Recorded {
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
    meetUrl: isMeet && !event.roomUrl ? event.meetUrl : null,
    roomUrl: isMeet ? event.roomUrl : null,
    pendingOwner: null,
  };
  // The offer for this start now owns the booked event, in the same write as
  // the booking, and keeps its travel refs so later cleanup knows its buffers.
  const owned = request.offered.map((o) => Date.parse(o.start) === Date.parse(event.start) ? { ...o, holdId: event.id, account } : o);
  if (owned.some((o, i) => o.holdId !== request.offered[i]!.holdId || o.account !== request.offered[i]!.account)) patch.offered = owned;
  // A reminder belongs to one start time: a moved meeting gets a new one.
  if (request.booked && Date.parse(request.booked.start) !== Date.parse(event.start)) patch.reminder = null;
  const next = updateRequest(ledger, id, patch, now);
  const meetUrl = (next.requests.find((r) => r.id === id) as Request).meetUrl ?? null;
  return { ledger: next, meetUrl, ...(isMeet && !event.roomUrl && !meetUrl ? { warning: "no-meet-link" as const } : {}) };
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
      result = recordBooking(l, values.id!, event, values.account!, Date.now());
      return result.ledger;
    });
    const { ledger, ...rest } = result!;
    return { request: ledger.requests.find((r) => r.id === values.id), ...rest };
  });
}
