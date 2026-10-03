// Decides a due Meet reminder against the calendar as it is now, not as the
// ledger remembers it: a moved meeting is reminded at its new time, a deleted
// one never, and the link sent is the one on the event. The poll sends the
// message itself, then marks it with --sent.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { loadConfig, reminderLeadMin } from "./config.ts";
import { readEvent, type EventInfo } from "./event.ts";
import { updateRequest, type Ledger, type Patch, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { updateJson } from "./store.ts";

export type Send = {
  chatUid: string | null; // null: the group never linked, so tell the owner instead
  meetUrl: string;
  name?: string;
  locale: string;
  time: string; // the start, as the person reads it
  minutesToStart: number;
};
export type Decision = {
  action: "send" | "wait" | "cancelled" | "no-link" | "skip";
  patch: Patch;
  send?: Send;
};
export type Options = { leadMin: number; tz: string; graceMin?: number };

const MIN = 60_000;

function timeLabel(ms: number, locale: string, tz: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

export function checkReminder(request: Request, event: EventInfo, now: number, opts: Options): Decision {
  if (request.status !== "booked") return { action: "skip", patch: {} };
  if (event.id !== request.eventId) throw new Error(`event ${event.id} is not this request's event (${request.eventId})`);
  const at = new Date(now).toISOString();
  if (event.status === "cancelled") return { action: "cancelled", patch: { status: "cancelled", reminder: { at, outcome: "cancelled" } } };
  // A cancellation is caught even after the reminder went out; nothing else is sent twice.
  if (request.format !== "meet" || request.reminder) return { action: "skip", patch: {} };

  const patch: Patch = {};
  const booked = request.booked!;
  if (Date.parse(event.start) !== Date.parse(booked.start) || Date.parse(event.end) !== Date.parse(booked.end)) {
    patch.booked = { start: event.start, end: event.end, account: booked.account };
  }
  // The link is the one on the event, or the owner's Zoom room saved at booking
  // while the live event's location still shows that same room.
  const link = event.meetUrl ?? (request.roomUrl && event.roomUrl === request.roomUrl ? request.roomUrl : null);
  if (!link) return { action: "no-link", patch: { ...patch, reminder: { at, outcome: "no-link" } } };
  if (event.meetUrl && event.meetUrl !== request.meetUrl) patch.meetUrl = event.meetUrl;

  const start = Date.parse(event.start);
  const grace = opts.graceMin ?? 5;
  if (now < start - opts.leadMin * MIN || now >= start + grace * MIN) return { action: "wait", patch };
  const locale = request.locale ?? "en-US";
  return {
    action: "send",
    patch,
    send: {
      chatUid: request.chatUid ?? null,
      meetUrl: link,
      ...(request.name ? { name: request.name } : {}),
      locale,
      time: timeLabel(start, locale, opts.tz),
      minutesToStart: Math.max(0, Math.round((start - now) / MIN)),
    },
  };
}

export function markSent(ledger: Ledger, id: string, now: number): Ledger {
  const request = ledger.requests.find((r) => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  if (request.reminder) throw new Error(`request ${id}'s reminder was already handled (${request.reminder.outcome})`);
  return updateRequest(ledger, id, { reminder: { at: new Date(now).toISOString(), outcome: "sent" } }, now);
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: { id: { type: "string" }, "event-file": { type: "string" }, sent: { type: "boolean" }, "lead-min": { type: "string" } },
    });
    const path = file("ledger.json");
    const empty: Ledger = { requests: [] };
    if (values.id && values.sent) {
      const ledger = updateJson<Ledger>(path, empty, (l) => markSent(l, values.id!, Date.now()));
      return { request: ledger.requests.find((r) => r.id === values.id) };
    }
    if (!values.id || !values["event-file"]) {
      throw new Error("usage: reminder-check.ts --id X --event-file F [--lead-min N] | --id X --sent");
    }
    const leadMin = values["lead-min"] !== undefined ? Number(values["lead-min"]) : reminderLeadMin();
    if (!Number.isFinite(leadMin) || leadMin <= 0) throw new Error(`--lead-min must be a number > 0, got ${values["lead-min"]}`);
    const event = readEvent(values["event-file"]);
    const { timezone } = loadConfig();
    const now = Date.now();
    let decision: Decision | undefined;
    updateJson<Ledger>(path, empty, (l) => {
      const request = l.requests.find((r) => r.id === values.id);
      if (!request) throw new Error(`no request ${values.id}`);
      decision = checkReminder(request, event, now, { leadMin, tz: timezone });
      return Object.keys(decision.patch).length ? updateRequest(l, request.id, decision.patch, now) : l;
    });
    const { patch: _patch, ...out } = decision!;
    return out;
  });
}
