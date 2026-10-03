// Meetly's record of every scheduling request: who, which group, which times
// were offered and held, and how it ended. Holds are only ever deleted by id
// from here, never by searching the calendar.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { isEmailAddress } from "./reachable-handle.ts";
import { DEFAULT_FORMATS, holdHours, reminderLeadMin, type DefaultFormat } from "./config.ts";
import { isMeetUrl, isZoomRoomUrl } from "./event.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

const STATUSES = ["offered", "booked", "dropped", "expired", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export type HoldRef = { holdId: string; account: string };
export type Offer = { start: string; end: string; holdId?: string; account: string; travel?: HoldRef[] };
// A time outside the owner's days or window that the other person asked for,
// waiting for the owner's yes or no.
// `travel`: the buffers held for this time while the owner decides; the booking takes them, anything else queues them for cleanup.
export type PendingOwner = { start: string; end: string; askedAt: string; travel?: HoldRef[] };
export type Constraints = { days?: string[]; after?: string; before?: string; from?: string; to?: string };
// How the meeting happens. `unknown` until the request or an answer says it.
export type Format = DefaultFormat | "unknown";
// The booked event's time, and the Google account it lives on.
// `travel` holds the buffers around it, when it is an in-person meeting that has them.
export type Booked = { start: string; end: string; account: string; travel?: HoldRef[] };
// The join-time reminder was handled: sent, or not sent for good.
export type Reminder = { at: string; outcome: "sent" | "cancelled" | "no-link" };

export type Request = {
  id: string;
  origin: "inbound" | "owner";
  handle: string;
  name?: string;
  sourceRowid?: number;
  chatUid?: string;
  topic: string;
  location?: string;
  // Where the calendar invitation goes: from contacts, or given by the owner, or approved by them.
  attendeeEmail?: string;
  durationMin: number;
  constraints?: Constraints;
  allowOverlap?: string[];
  offered: Offer[];
  // A re-offer to a group the person already has: it becomes `offered` only
  // once its message is sent (`settleOffer`), so the last delivered offer
  // stays current, and keeps its holds, until then.
  pendingOffer?: { revision: string; offered: Offer[]; offeredAt: string };
  status: Status;
  eventId?: string;
  holdCleanup?: HoldRef[];
  // The buffers of a move in progress: owned by nobody, and not yet cleanable, until the calendar update succeeds.
  pendingTravel?: { refs: HoldRef[]; at: string; revision: string; start: string; end: string };
  pendingOwner?: PendingOwner;
  format?: Format;
  locale?: string;
  booked?: Booked;
  meetUrl?: string;
  // The owner's own Zoom room, from their configuration, when that is the video link.
  roomUrl?: string;
  reminder?: Reminder;
  offeredAt: string;
  // When it stopped being open (dropped, expired, ...), so later bookkeeping does not move it.
  closedAt?: string;
  // When the owner was last reminded about this request, so a reminder goes out once per ask.
  nudgedAt?: string;
  // When the other person was last nudged about this offer.
  personNudgedAt?: string;
  // What happened and was confirmed, dated, oldest first (the last LOG_MAX).
  log?: LogEntry[];
  createdAt: string;
  updatedAt: string;
};

export type LogEntry = { at: string; text: string };
const LOG_MAX = 30;
const LOG_TEXT_MAX = 300;

export type Ledger = { requests: Request[] };

export type NewRequest = Omit<Request,
  "id" | "status" | "eventId" | "pendingOwner" | "booked" | "meetUrl" | "roomUrl" | "reminder" | "offeredAt" | "closedAt" | "nudgedAt" | "personNudgedAt" | "log" | "createdAt" | "updatedAt">;
export type Patch = Partial<Pick<Request,
  "status" | "chatUid" | "eventId" | "offered" | "holdCleanup" | "name" | "location" | "allowOverlap" | "constraints" | "topic" | "format" | "locale">> & {
  attendeeEmail?: string;
  pendingOwner?: PendingOwner | null;
  booked?: Booked | null;
  meetUrl?: string | null;
  roomUrl?: string | null;
  reminder?: Reminder | null;
  nudgedAt?: string;
  personNudgedAt?: string | null;
};

const FORMATS: readonly Format[] = [...DEFAULT_FORMATS, "unknown"];
const OUTCOMES: readonly Reminder["outcome"][] = ["sent", "cancelled", "no-link"];
const PATCH_KEYS = [
  "status", "chatUid", "eventId", "offered", "holdCleanup", "name", "location", "allowOverlap", "constraints", "topic", "pendingOwner",
  "format", "locale", "booked", "meetUrl", "roomUrl", "reminder", "nudgedAt", "personNudgedAt", "attendeeEmail",
];
// Keys a patch can clear with null.
const NULLABLE = ["pendingOwner", "booked", "meetUrl", "roomUrl", "reminder", "personNudgedAt"] as const;

const isDate = (t: unknown) => typeof t === "string" && !Number.isNaN(Date.parse(t));

function checkFormat(format: unknown): void {
  if (!FORMATS.includes(format as Format)) throw new Error(`format must be one of ${FORMATS.join(", ")}, got ${JSON.stringify(format)}`);
}

function checkLocale(locale: unknown): void {
  if (typeof locale !== "string" || !locale.trim() || locale.length > 35) {
    throw new Error(`locale must be a language tag like pt-BR, got ${JSON.stringify(locale)}`);
  }
}

function checkBooked(b: Booked): void {
  if (!b || !isDate(b.start) || !isDate(b.end) || Date.parse(b.end) <= Date.parse(b.start)
    || typeof b.account !== "string" || !b.account) {
    throw new Error(`booked needs a valid start, a later end and an account: ${JSON.stringify(b)}`);
  }
  if (b.travel !== undefined) checkHoldRefs(b.travel, "booked travel");
}

function checkEmail(email: unknown): string {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!isEmailAddress(e)) throw new Error(`attendeeEmail must be an email address, got ${JSON.stringify(email)}`);
  return e;
}

function checkReminder(r: Reminder): void {
  if (!r || !isDate(r.at) || !OUTCOMES.includes(r.outcome)) {
    throw new Error(`reminder needs a valid at and an outcome of ${OUTCOMES.join(", ")}: ${JSON.stringify(r)}`);
  }
}

function checkHoldRefs(refs: unknown, field: string): asserts refs is HoldRef[] {
  if (!Array.isArray(refs) || refs.some((h) =>
    !h || typeof h.holdId !== "string" || !h.holdId.trim() || typeof h.account !== "string" || !h.account.trim())) {
    throw new Error(`${field} must be a list of hold ids and accounts: ${JSON.stringify(refs)}`);
  }
}

const isEmail = (h: string) => h.includes("@");

// An email is lowercased; a phone keeps a leading + and its digits.
export function normalizeHandle(h: string): string {
  const t = h.trim();
  if (isEmail(t)) return t.toLowerCase();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}

// iMessage gives +15551234567 while Contacts gives (555) 123-4567: two phones
// match when the shorter one (7+ digits) is a suffix of the longer.
export function sameHandle(a: string, b: string): boolean {
  const na = normalizeHandle(a);
  const nb = normalizeHandle(b);
  if (na === nb) return na !== "" && na !== "+";
  if (isEmail(na) || isEmail(nb)) return false;
  // Two full international numbers are the same only when equal; the suffix rule is for a local number against an E.164 one.
  if (na.startsWith("+") && nb.startsWith("+")) return false;
  const da = na.replace("+", "");
  const db = nb.replace("+", "");
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 7 && long.endsWith(short);
}

export function findOpenByHandle(ledger: Ledger, handle: string): Request | undefined {
  return ledger.requests.find((r) => r.status === "offered" && sameHandle(r.handle, handle));
}

export function findByChat(ledger: Ledger, chatUid: string, handle?: string): Request | undefined {
  // Resolve an open request for the sender even when it has not been linked
  // yet. This lets a replacement offer supersede a closed request in the chat.
  if (handle !== undefined) {
    const openForHandle = findOpenByHandle(ledger, handle);
  if (openForHandle && (openForHandle.chatUid === undefined || openForHandle.chatUid === chatUid)) {
      return openForHandle;
    }
  }
  // A chat remains a Meetly group after its request closes.
  return ledger.requests.findLast((r) => r.chatUid === chatUid && r.status === "offered")
    ?? ledger.requests.findLast((r) => r.chatUid === chatUid);
}

// The request booked as this calendar event on this account: how an owner's
// cancel or move of an event finds the person and group to tell. A booking
// with no recorded account never matches.
export function findByEvent(ledger: Ledger, eventId: string, account: string): Request | undefined {
  return ledger.requests.findLast((r) => r.eventId === eventId && r.booked?.account === account);
}

function checkOffers(offered: unknown): Offer[] {
  if (!Array.isArray(offered) || offered.length === 0) throw new Error("offered must be a non-empty list");
  for (const o of offered as Offer[]) {
    if (!o || Number.isNaN(Date.parse(o.start)) || Number.isNaN(Date.parse(o.end))) {
      throw new Error(`each offer needs a valid start and end: ${JSON.stringify(o)}`);
    }
    if (typeof o.account !== "string" || !o.account) throw new Error(`each offer needs an account: ${JSON.stringify(o)}`);
    if (o.travel !== undefined) checkHoldRefs(o.travel, "each offer travel");
  }
  return offered as Offer[];
}

export function addRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  if (input.origin !== "inbound" && input.origin !== "owner") throw new Error(`origin must be inbound or owner, got ${input.origin}`);
  if (typeof input.handle !== "string" || !input.handle.trim()) throw new Error("handle is required");
  if (typeof input.topic !== "string" || !input.topic.trim()) throw new Error("topic is required");
  if (!Number.isInteger(input.durationMin) || input.durationMin <= 0) throw new Error("durationMin must be a positive whole number");
  checkOffers(input.offered);
  if (input.holdCleanup !== undefined) checkHoldRefs(input.holdCleanup, "holdCleanup");
  const format = input.format === undefined ? "unknown" : input.format;
  checkFormat(format);
  if (input.locale !== undefined) checkLocale(input.locale);
  const attendeeEmail = input.attendeeEmail === undefined ? undefined : checkEmail(input.attendeeEmail);
  const open = findOpenByHandle(ledger, input.handle);
  if (open) throw new Error(`open request ${open.id} already exists for this person; update it instead`);
  const at = new Date(now).toISOString();
  // A new offer is never booked: a booking, its link and its reminder are
  // only ever set through update, where they are validated.
  const { booked: _b, meetUrl: _m, roomUrl: _z, reminder: _r, closedAt: _c, nudgedAt: _n, personNudgedAt: _pn, log: _l, ...fields } = input as NewRequest & Partial<Pick<Request, "booked" | "meetUrl" | "roomUrl" | "reminder" | "closedAt" | "nudgedAt" | "personNudgedAt" | "log">>;
  const request: Request = { ...fields, ...(attendeeEmail ? { attendeeEmail } : {}), format, id, status: "offered", offeredAt: at, createdAt: at, updatedAt: at };
  return { requests: [...ledger.requests, request] };
}

// An offer's holds: the meeting hold and its travel blocks.
const holdRefs = (offers: Offer[]): HoldRef[] => offers.flatMap((o) => [
  ...(o.holdId ? [{ holdId: o.holdId, account: o.account }] : []),
  ...(o.travel ?? []),
]);
const mergeRefs = (...lists: HoldRef[][]): HoldRef[] => lists.flat()
  .filter((hold, i, all) => all.findIndex((h) => h.holdId === hold.holdId && h.account === hold.account) === i);
const withoutRefs = (refs: HoldRef[], keep: HoldRef[]): HoldRef[] =>
  refs.filter((hold) => !keep.some((h) => h.holdId === hold.holdId && h.account === hold.account));

// Save the latest offer for a person without creating a second open request.
// This makes a retry after holds were created safe: the existing request id
// (and its chat link, when one exists) remains stable. When the person already
// has a group, the new offer is only staged (`pendingOffer`, with a fresh
// `revision`): the delivered offer and its holds stay current until
// `settleOffer` promotes the new one after a successful send or discards it.
// A staged offer is an exclusive in-flight state: no second save may replace it.
export function saveRequest(ledger: Ledger, input: NewRequest, now: number, id: string, revision = id): Ledger {
  const existing = findOpenByHandle(ledger, input.handle);
  if (!existing) return addRequest(ledger, input, now, id);

  // Reuse addRequest's validation and timestamp behavior, then apply its new
  // offer to the existing record. An absent chatUid must not erase the link.
  const validated = addRequest(EMPTY, input, now, id).requests[0]!;
  const fields: Request = {
    ...existing,
    ...validated,
    id: existing.id,
    chatUid: input.chatUid ?? existing.chatUid,
    // A new offer that does not name a format keeps the one already answered.
    format: validated.format === "unknown" ? existing.format ?? "unknown" : validated.format,
    locale: input.locale ?? existing.locale,
    createdAt: existing.createdAt,
    updatedAt: new Date(now).toISOString(),
  };
  const next = holdRefs(validated.offered);
  let replacement: Request;
  if (existing.chatUid !== undefined) {
    if (existing.pendingOffer) throw new Error(`request ${existing.id} already has an offer being sent; wait for it to settle, or for the cleanup poll to discard it`);
    replacement = {
      ...fields,
      offered: existing.offered,
      offeredAt: existing.offeredAt,
      holdCleanup: mergeRefs(existing.holdCleanup ?? [], validated.holdCleanup ?? []),
      pendingOffer: { revision, offered: validated.offered, offeredAt: validated.offeredAt },
    };
  } else {
    const { pendingOffer: _p, ...rest } = fields;
    replacement = { ...rest, personNudgedAt: undefined, holdCleanup: mergeRefs(existing.holdCleanup ?? [], validated.holdCleanup ?? [], withoutRefs(holdRefs(existing.offered), next)) };
  }
  return { requests: ledger.requests.map((r) => r.id === existing.id ? replacement : r) };
}

// Settle a staged offer once its message has been sent (promote) or has failed
// (discard). Whichever offer loses gives up its holds, except any the winner
// keeps, and the loser's holds enter the cleanup queue in the same atomic
// write, before any deletion. A `revision` that is no longer the staged one
// (another save replaced it) leaves the ledger untouched.
export function settleOffer(ledger: Ledger, id: string, revision: string, outcome: "promote" | "discard", now: number): Ledger {
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const { pendingOffer, ...current } = ledger.requests[index]!;
  if (!pendingOffer || pendingOffer.revision !== revision) return ledger;
  const promote = outcome === "promote" && current.status === "offered";
  const winner = promote ? pendingOffer.offered : current.offered;
  const loser = promote ? current.offered : pendingOffer.offered;
  const requests = [...ledger.requests];
  requests[index] = {
    ...current,
    ...(promote ? { offered: pendingOffer.offered, offeredAt: new Date(now).toISOString(), personNudgedAt: undefined } : {}),
    holdCleanup: mergeRefs(current.holdCleanup ?? [], withoutRefs(holdRefs(loser), holdRefs(winner))),
    updatedAt: new Date(now).toISOString(),
  };
  return { requests };
}

// A turn that died between `save` and its send leaves a staged offer behind:
// after `maxAgeMs` it is discarded so its holds are cleaned up.
export function discardStaleOffers(ledger: Ledger, now: number, maxAgeMs: number): Ledger {
  return ledger.requests.reduce((l, r) => r.pendingOffer && now - Date.parse(r.pendingOffer.offeredAt) > maxAgeMs
    ? settleOffer(l, r.id, r.pendingOffer.revision, "discard", now) : l, ledger);
}

// Moving a booked meeting that has travel buffers. One move at a time per
// booking: the new buffers wait in `pendingTravel` (with the target time),
// which the cleanup poll ignores, and a second stage is refused while one is
// pending. `commit` makes them the meeting's buffers and queues the old ones,
// in one write, only after the calendar update succeeded.
export const TRAVEL_STAGE_MAX_MS = 15 * 60_000;

export function stageTravel(ledger: Ledger, id: string, refs: HoldRef[], target: { start: string; end: string }, now: number, revision = id): Ledger {
  checkHoldRefs(refs, "travel hold");
  if (![target?.start, target?.end].every(isDate)) throw new Error(`stage-travel needs the target "start" and "end" of the move: ${JSON.stringify(target)}`);
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const current = ledger.requests[index]!;
  if (current.status !== "booked") throw new Error(`request ${id} is not booked`);
  if (current.pendingTravel) throw new Error(`request ${id} already has a move in progress (or awaiting reconciliation): delete the buffers you just created and try again in a few minutes`);
  const requests = [...ledger.requests];
  requests[index] = { ...current, pendingTravel: { refs, at: new Date(now).toISOString(), revision, start: target.start, end: target.end }, updatedAt: new Date(now).toISOString() };
  return { requests };
}

// A commit applies only to the stage it was issued for: when the stage was
// reconciled away meanwhile, the ledger is left untouched and the caller told.
// The one promotion transition: the stage's target time and buffers become the
// booking's together (so cancellation polling and the pipeline see the new
// interval at once), the old buffers are queued, and a reminder that belonged
// to the old start is cleared. Both commit and reconciliation go through it.
function promoteTravel(ledger: Ledger, index: number, now: number): Ledger {
  const { pendingTravel, ...current } = ledger.requests[index]!;
  const requests = [...ledger.requests];
  const moved = Date.parse(current.booked!.start) !== Date.parse(pendingTravel!.start);
  const next: Request = {
    ...current,
    booked: { ...current.booked!, start: pendingTravel!.start, end: pendingTravel!.end, travel: pendingTravel!.refs },
    holdCleanup: mergeRefs(current.holdCleanup ?? [], withoutRefs(current.booked!.travel ?? [], pendingTravel!.refs)),
    updatedAt: new Date(now).toISOString(),
  };
  if (moved) delete next.reminder;
  requests[index] = next;
  return { requests };
}

export function commitTravel(ledger: Ledger, id: string, revision: string, now: number): { ledger: Ledger; committed: boolean } {
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const current = ledger.requests[index]!;
  if (current.status !== "booked" || !current.booked) throw new Error(`request ${id} is not a booked meeting`);
  if (!current.pendingTravel || current.pendingTravel.revision !== revision) return { ledger, committed: false };
  return { ledger: promoteTravel(ledger, index, now), committed: true };
}

// Set the buffers of one offer (open request, by its start) or of the booking
// (booked request): a targeted write, so a caller never rewrites `offered[]`.
export function setTravel(ledger: Ledger, id: string, refs: HoldRef[], start: string | undefined, now: number): Ledger {
  checkHoldRefs(refs, "travel hold");
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const current = ledger.requests[index]!;
  const requests = [...ledger.requests];
  const updatedAt = new Date(now).toISOString();
  if (current.status === "booked") {
    if (!current.booked) throw new Error(`request ${id} has no booking`);
    const { travel: _t, ...booked } = current.booked;
    requests[index] = { ...current, booked: refs.length ? { ...booked, travel: refs } : booked, updatedAt };
    return { requests };
  }
  if (current.status !== "offered") throw new Error(`request ${id} is ${current.status}`);
  // An owner-approved out-of-hours time is no offer: its buffers are held on the pending approval.
  if (start && current.pendingOwner && Date.parse(current.pendingOwner.start) === Date.parse(start) && !current.offered.some((o) => Date.parse(o.start) === Date.parse(start))) {
    // A retry that holds a new pair displaces the first: those refs go to cleanup in the same write.
    const displaced = withoutRefs(current.pendingOwner.travel ?? [], refs);
    requests[index] = {
      ...current,
      pendingOwner: { ...current.pendingOwner, travel: refs },
      ...(displaced.length ? { holdCleanup: mergeRefs(current.holdCleanup ?? [], displaced) } : {}),
      updatedAt,
    };
    return { requests };
  }
  if (!start || !current.offered.some((o) => Date.parse(o.start) === Date.parse(start))) throw new Error(`request ${id} has no offer starting ${start}`);
  requests[index] = { ...current, offered: current.offered.map((o) => (Date.parse(o.start) === Date.parse(start) ? { ...o, travel: refs } : o)), updatedAt };
  return { requests };
}

// A turn that died between the stage and the commit leaves a stage behind. After
// the stage timeout the poll reads the live event and decides: if the calendar
// accepted the move (the event is at the target time) the booking takes the new
// buffers and time; otherwise the staged buffers go to cleanup.
export const staleTravelStage = (r: Request, now: number): boolean =>
  r.pendingTravel !== undefined && now - Date.parse(r.pendingTravel.at) > TRAVEL_STAGE_MAX_MS;

export function reconcileTravel(ledger: Ledger, id: string, event: { start: string; end: string }, now: number): Ledger {
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const stage = ledger.requests[index]!;
  if (!stage.pendingTravel || !staleTravelStage(stage, now)) return ledger;
  // The calendar took the move only if both endpoints are the ones the buffers were computed for.
  if (stage.status === "booked" && stage.booked && Date.parse(event.start) === Date.parse(stage.pendingTravel.start) && Date.parse(event.end) === Date.parse(stage.pendingTravel.end)) {
    return promoteTravel(ledger, index, now);
  }
  const { pendingTravel, ...current } = stage;
  const requests = [...ledger.requests];
  requests[index] = { ...current, holdCleanup: mergeRefs(current.holdCleanup ?? [], pendingTravel.refs), updatedAt: new Date(now).toISOString() };
  return { requests };
}

export function removeCleanupRef(ledger: Ledger, id: string, ref: HoldRef, now: number): Ledger {
  checkHoldRefs([ref], "hold");
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const current = ledger.requests[index]!;
  const requests = [...ledger.requests];
  requests[index] = {
    ...current,
    holdCleanup: (current.holdCleanup ?? []).filter((h) => h.holdId !== ref.holdId || h.account !== ref.account),
    updatedAt: new Date(now).toISOString(),
  };
  return { requests };
}

export function updateRequest(ledger: Ledger, id: string, patch: Patch, now: number): Ledger {
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) throw new Error(`unknown key: ${key} (allowed: ${PATCH_KEYS.join(", ")})`);
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`bad status: ${patch.status}`);
  if (patch.offered !== undefined) checkOffers(patch.offered);
  if (patch.holdCleanup !== undefined) checkHoldRefs(patch.holdCleanup, "holdCleanup");
  const pending = patch.pendingOwner;
  if (pending) {
    if ([pending.start, pending.end, pending.askedAt].some((t) => typeof t !== "string" || Number.isNaN(Date.parse(t)))) {
      throw new Error(`pendingOwner needs valid start, end and askedAt: ${JSON.stringify(pending)}`);
    }
  }
  if (patch.format !== undefined) checkFormat(patch.format);
  if (patch.locale !== undefined) checkLocale(patch.locale);
  const patched = patch.attendeeEmail !== undefined ? { ...patch, attendeeEmail: checkEmail(patch.attendeeEmail) } : patch;
  if (patch.booked) checkBooked(patch.booked);
  if (patch.reminder) checkReminder(patch.reminder);
  if (patch.nudgedAt !== undefined && !isDate(patch.nudgedAt)) throw new Error(`nudgedAt must be a time, got ${JSON.stringify(patch.nudgedAt)}`);
  if (patch.personNudgedAt !== undefined && patch.personNudgedAt !== null && !isDate(patch.personNudgedAt)) throw new Error(`personNudgedAt must be a time, got ${JSON.stringify(patch.personNudgedAt)}`);
  if (patch.meetUrl !== undefined && patch.meetUrl !== null && !isMeetUrl(patch.meetUrl)) {
    throw new Error(`meetUrl must be a Google Meet link (https://meet.google.com/xxx-xxxx-xxx), got ${JSON.stringify(patch.meetUrl)}`);
  }
  if (patch.roomUrl !== undefined && patch.roomUrl !== null && !isZoomRoomUrl(patch.roomUrl)) {
    throw new Error(`roomUrl must be the owner's Zoom room link (https://zoom.us/j/...), got ${JSON.stringify(patch.roomUrl)}`);
  }
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const currentRequest = ledger.requests[index]!;
  const at = new Date(now).toISOString();
  const updated: Request = { ...ledger.requests[index]!, updatedAt: at };
  if (currentRequest.status !== "offered" && currentRequest.status !== "booked" && !currentRequest.closedAt) {
    updated.closedAt = currentRequest.log?.at(-1)?.at ?? currentRequest.updatedAt;
  }
  for (const [key, value] of Object.entries(patched)) {
    if (value === null && (NULLABLE as readonly string[]).includes(key)) delete updated[key as (typeof NULLABLE)[number]];
    else if (value !== undefined) (updated as Record<string, unknown>)[key] = value;
  }
  // A booked meeting that closes gives its travel buffers to cleanup in the same write.
  if (currentRequest.status === "booked" && patch.status !== undefined && patch.status !== "booked") {
    const owned = [...(currentRequest.booked?.travel ?? []), ...(currentRequest.pendingTravel?.refs ?? [])];
    if (owned.length) updated.holdCleanup = mergeRefs(updated.holdCleanup ?? [], owned);
    delete updated.pendingTravel;
  }
  // Buffers held for a pending approval that is cleared or replaced without becoming the booking go to cleanup.
  const heldForOwner = currentRequest.pendingOwner?.travel;
  if (heldForOwner?.length && (patch.pendingOwner !== undefined || (patch.status !== undefined && patch.status !== "offered"))) {
    const kept = withoutRefs(heldForOwner, [...(updated.booked?.travel ?? []), ...(updated.pendingOwner?.travel ?? [])]);
    if (kept.length) updated.holdCleanup = mergeRefs(updated.holdCleanup ?? [], kept);
  }
  // A link belongs to a Meet: moving to another format drops it, and a link
  // is never set on a meeting that is not one.
  if (updated.meetUrl !== undefined && updated.format !== "meet") {
    if (patch.meetUrl) throw new Error(`meetUrl is only for a meeting with format meet (this one is ${updated.format ?? "unknown"})`);
    delete updated.meetUrl;
  }
  // When it stops being open, remember when; reopening clears it.
  if (patch.status !== undefined && patch.status !== ledger.requests[index]!.status) {
    if (patch.status === "offered" || patch.status === "booked") delete updated.closedAt;
    else updated.closedAt = at;
  }
  if (updated.roomUrl !== undefined && updated.format !== "meet") {
    if (patch.roomUrl) throw new Error(`roomUrl is only for a video meeting with format meet (this one is ${updated.format ?? "unknown"})`);
    delete updated.roomUrl;
  }
  if (patch.offered !== undefined) updated.offeredAt = at;
  const requests = [...ledger.requests];
  requests[index] = updated;
  return { requests };
}

// One dated line of what happened. It is written only after the calendar or
// the chat confirmed it, and the log is bounded: the oldest lines go first.
export function appendLog(ledger: Ledger, id: string, text: string, now: number): Ledger {
  const line = typeof text === "string" ? text.trim() : "";
  if (!line || line.length > LOG_TEXT_MAX) throw new Error(`the log text must be 1 to ${LOG_TEXT_MAX} characters`);
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const at = new Date(now).toISOString();
  const requests = [...ledger.requests];
  const r = requests[index]!;
  const closedAt = r.status !== "offered" && r.status !== "booked" ? r.closedAt ?? r.updatedAt : r.closedAt;
  requests[index] = { ...r, ...(closedAt ? { closedAt } : {}), log: [...(r.log ?? []), { at, text: line }].slice(-LOG_MAX), updatedAt: at };
  return { requests };
}

export function expiredRequests(ledger: Ledger, hours: number, now: number): Request[] {
  // A request with an offer being sent is not expired: its send settles first.
  return ledger.requests.filter((r) => r.status === "offered" && !r.pendingOffer && now - Date.parse(r.offeredAt) >= hours * 3600_000);
}

// Open requests waiting for the owner to confirm an out-of-hours time.
export function pendingOwnerList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => r.status === "offered" && r.pendingOwner !== undefined);
}

// Booked meetings to re-read from the calendar: from `leadMin` before the
// start until `graceMin` after it. A cancellation is caught for any format,
// and, reminded or not, only a Meet with a link gets a reminder. A booking
// with travel buffers is re-read from the booking until the meeting ends, so
// a cancelled event, even an in-progress one, queues its buffers.
export function dueReminders(ledger: Ledger, now: number, leadMin: number, graceMin = 5): Request[] {
  return ledger.requests.filter((r) => {
    if (r.status !== "booked" || !r.eventId || !r.booked) return false;
    if (staleTravelStage(r, now)) return true;
    if (r.booked.travel?.length) return now < Date.parse(r.booked.end);
    const start = Date.parse(r.booked.start);
    return now >= start - leadMin * 60_000 && now < start + graceMin * 60_000;
  });
}

export function cleanupList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => (r.holdCleanup?.length ?? 0) > 0);
}

// The spec's stages, derived from the ledger and never stored. "new" is a
// request with no entry yet, and a person on the do-not-contact list has
// their own list (blocklist.ts).
export type Stage = "waiting_on_us" | "delivery_unknown" | "sent" | "waiting_on_them" | "confirmed" | "passed";

// One request as the owner sees it in the pipeline: no chat uid, and a booking
// only by its start and end.
export type PipelineItem = {
  id: string;
  name?: string;
  topic: string;
  status: Status;
  stage: Stage;
  delivery: "linked" | "unknown";
  nextStep: string;
  hoursWaiting?: number;
  booked?: { start: string; end: string };
  closedAt?: string;
};

export const STALE_HOURS = 24;
const WEEK = 7 * 24 * 3600_000;
const hoursSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 3600_000));
const closedWhen = (r: Request) => r.closedAt ?? r.log?.at(-1)?.at ?? r.updatedAt;

const NEXT_STEP: Record<Stage, string> = {
  waiting_on_us: "owner decision needed",
  delivery_unknown: "delivery is unknown: check Messages manually; never resend",
  sent: "wait for their answer",
  waiting_on_them: "no answer in a day: suggest new times",
  confirmed: "none",
  passed: "none, unless the owner wants to meet again",
};

export function stageOf(r: Request, now: number): Stage {
  if (r.status === "booked") return "confirmed";
  if (r.status !== "offered") return "passed";
  if (r.pendingOwner) return "waiting_on_us";
  if (!r.chatUid) return "delivery_unknown";
  return hoursSince(r.offeredAt, now) >= STALE_HOURS ? "waiting_on_them" : "sent";
}

// Who is waiting on whom: offers the owner has to approve, offers held but not
// delivered (waiting on Meetly), offers the other person has to answer (oldest
// first), meetings still to come (soonest first; one with no recorded time
// last), and what closed in the past week.
const pipelineItem = (r: Request, now: number, extra: Partial<PipelineItem> = {}): PipelineItem => {
  const stage = stageOf(r, now);
  const out: PipelineItem = { id: r.id, topic: r.topic, status: r.status, stage, delivery: r.chatUid ? "linked" : "unknown", nextStep: NEXT_STEP[stage], ...extra };
  if (r.name !== undefined) out.name = r.name;
  return out;
};

export function pipeline(ledger: Ledger, now: number, blocked: string[] = []): {
  waitingOnOwner: PipelineItem[]; deliveryUnknown: PipelineItem[]; waitingOnThem: PipelineItem[]; booked: PipelineItem[]; closed: PipelineItem[];
} {
  const item = (r: Request, extra: Partial<PipelineItem> = {}) => pipelineItem(r, now, extra);
  const waiting = (r: Request) => ({ hoursWaiting: hoursSince(r.pendingOwner?.askedAt ?? r.offeredAt, now) });
  const requests = ledger.requests.filter((r) => !blocked.some((b) => sameHandle(b, r.handle)));
  const open = requests.filter((r) => r.status === "offered");
  const upcoming = requests.filter((r) => r.status === "booked" && (!r.booked || Date.parse(r.booked.start) >= now));
  const startOf = (r: Request) => (r.booked ? Date.parse(r.booked.start) : Infinity);
  const byStage = (stage: (r: Request) => boolean) => open.filter(stage).map((r) => item(r, waiting(r)));
  return {
    waitingOnOwner: byStage((r) => stageOf(r, now) === "waiting_on_us"),
    deliveryUnknown: byStage((r) => stageOf(r, now) === "delivery_unknown").sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
    waitingOnThem: byStage((r) => ["sent", "waiting_on_them"].includes(stageOf(r, now))).sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
    booked: upcoming.sort((a, b) => startOf(a) - startOf(b)).map((r) => item(r, r.booked ? { booked: { start: r.booked.start, end: r.booked.end } } : {})),
    closed: requests.filter((r) => r.status !== "offered" && r.status !== "booked" && now - Date.parse(closedWhen(r)) <= WEEK)
      .sort((a, b) => closedWhen(b).localeCompare(closedWhen(a))).slice(0, 10).map((r) => item(r, { closedAt: closedWhen(r) })),
  };
}

export const OWNER_NUDGE_HOURS = 4;
export const DELIVERY_UNKNOWN_NOTICE_HOURS = 1;
export const PERSON_NUDGE_HOURS = 24;

// What waits on the owner or on Meetly for too long, to be reminded once per
// ask. The other person is nudged once per offer; replacing an offer resets it.
export function monitor(ledger: Ledger, now: number): {
  ownerWaiting: (PipelineItem & { chatUid?: string; handle: string })[]; deliveryUnknown: PipelineItem[]; waitingOnThem: (PipelineItem & { chatUid: string; handle: string })[];
} {
  const asked = (r: Request) => r.pendingOwner?.askedAt;
  const due = (r: Request, since: string, hours: number) =>
    hoursSince(since, now) >= hours && (!r.nudgedAt || Date.parse(r.nudgedAt) < Date.parse(since));
  const personDue = (r: Request) => hoursSince(r.offeredAt, now) >= PERSON_NUDGE_HOURS &&
    (!r.personNudgedAt || Date.parse(r.personNudgedAt) < Date.parse(r.offeredAt));
  const view = (r: Request, since: string): PipelineItem => pipelineItem(r, now, { hoursWaiting: hoursSince(since, now) });
  const open = ledger.requests.filter((r) => r.status === "offered");
  return {
    ownerWaiting: open.filter((r) => stageOf(r, now) === "waiting_on_us" && asked(r) && due(r, asked(r)!, OWNER_NUDGE_HOURS))
      .map((r) => ({ ...view(r, asked(r)!), handle: r.handle, ...(r.chatUid !== undefined ? { chatUid: r.chatUid } : {}) }))
      .sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
    deliveryUnknown: open.filter((r) => stageOf(r, now) === "delivery_unknown" && due(r, r.offeredAt, DELIVERY_UNKNOWN_NOTICE_HOURS))
      .map((r) => view(r, r.offeredAt)).sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
    waitingOnThem: open.filter((r) => stageOf(r, now) === "waiting_on_them" && r.chatUid && !r.pendingOffer && personDue(r))
      .map((r) => ({ ...view(r, r.offeredAt), chatUid: r.chatUid!, handle: r.handle }))
      .sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
  };
}

// Everything the ledger holds for one person, newest first: what the meeting
// was for, how it was to happen, where, for how long.
export function historyFor(ledger: Ledger, handle: string): Pick<Request, "id" | "status" | "name" | "topic" | "format" | "location" | "durationMin" | "createdAt">[] {
  // Exact, not suffix, matching: a similar number must never see this person's meetings.
  const who = normalizeHandle(handle);
  return ledger.requests.filter((r) => normalizeHandle(r.handle) === who)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, status, name, topic, format, location, durationMin, createdAt }) => ({ id, status, name, topic, format, location, durationMin, createdAt }));
}

const EMPTY: Ledger = { requests: [] };

function jsonArg(values: { json?: string; "json-file"?: string }): any {
  const text = values.json ?? (values["json-file"] !== undefined ? readFileSync(values["json-file"], "utf8") : undefined);
  if (text === undefined) throw new Error("pass --json '<object>' or --json-file F");
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the JSON must be an object");
  return value;
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
      args: rest,
      options: {
        "handles-file": { type: "string" },
        chat: { type: "string" },
        event: { type: "string" },
        account: { type: "string" },
        id: { type: "string" },
        revision: { type: "string" },
        json: { type: "string" },
        "text-file": { type: "string" },
        "json-file": { type: "string" },
        hours: { type: "string" },
        "lead-min": { type: "string" },
      },
    });
    const path = file("ledger.json");
    const now = Date.now();
    // A handle came from a message or a contact card, so it arrives in a JSON array file, never on the command line.
    const handle = values["handles-file"] ? (JSON.parse(readFileSync(values["handles-file"], "utf8")) as string[])[0] : undefined;
    switch (cmd) {
      case "find": {
        const ledger = readJson<Ledger>(path, EMPTY);
        if (values.event !== undefined) {
          if (!values.account) throw new Error("find --event needs --account: the account the event is on");
          return { request: findByEvent(ledger, values.event, values.account) ?? null };
        }
        if (values.chat !== undefined) return { request: findByChat(ledger, values.chat, handle) ?? null };
        if (handle !== undefined) return { request: findOpenByHandle(ledger, handle) ?? null };
        throw new Error("usage: ledger.ts find --handles-file F | --chat U | --event E --account A");
      }
      case "add": {
        const input = jsonArg(values);
        const id = `r_${randomBytes(4).toString("hex")}`;
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => addRequest(l, input, now, id));
        return { request: ledger.requests.find((r) => r.id === id) };
      }
      case "save": {
        const input = jsonArg(values);
        const id = `r_${randomBytes(4).toString("hex")}`;
        const revision = randomBytes(4).toString("hex");
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => saveRequest(l, input, now, id, revision));
        return { request: ledger.requests.find((r) => sameHandle(r.handle, input.handle) && r.status === "offered") };
      }
      case "update": {
        if (!values.id) throw new Error("usage: ledger.ts update --id X --json '<patch>'");
        const patch = jsonArg(values);
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => updateRequest(l, values.id!, patch, now));
        return { request: ledger.requests.find((r) => r.id === values.id) };
      }
      case "promote-offer":
      case "discard-offer": {
        if (!values.id || !values.revision) throw new Error(`usage: ledger.ts ${cmd} --id X --revision R`);
        const outcome = cmd === "promote-offer" ? "promote" : "discard";
        // Decided inside the locked write, from the state it actually settles.
        let settled = false;
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => {
          const before = l.requests.find((r) => r.id === values.id);
          settled = before?.pendingOffer?.revision === values.revision && (outcome === "discard" || before?.status === "offered");
          return settleOffer(l, values.id!, values.revision!, outcome, now);
        });
        return { request: ledger.requests.find((r) => r.id === values.id), settled };
      }
      case "cleanup-remove": {
        if (!values.id) throw new Error("usage: ledger.ts cleanup-remove --id X --json-file F");
        const ref = jsonArg(values) as HoldRef;
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => removeCleanupRef(l, values.id!, ref, now));
        return { request: ledger.requests.find((r) => r.id === values.id) };
      }
      case "set-travel": {
        if (!values.id) throw new Error(`usage: ledger.ts set-travel --id X --json-file F ({"start":"<offer start>","travel":[{holdId,account},…]})`);
        const { start, travel } = jsonArg(values) as { start?: string; travel: HoldRef[] };
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => setTravel(l, values.id!, travel, start, now));
        return { request: ledger.requests.find((r) => r.id === values.id) };
      }
      case "stage-travel": {
        if (!values.id) throw new Error(`usage: ledger.ts stage-travel --id X --json-file F ({"travel":[{holdId,account},…],"start":"<new start>","end":"<new end>"})`);
        const { travel } = jsonArg(values) as { travel: HoldRef[] };
        const revision = randomBytes(4).toString("hex");
        const { start, end } = jsonArg(values) as { start: string; end: string };
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => stageTravel(l, values.id!, travel, { start, end }, now, revision));
        return { request: ledger.requests.find((r) => r.id === values.id), revision };
      }
      case "commit-travel": {
        if (!values.id || !values.revision) throw new Error("usage: ledger.ts commit-travel --id X --revision R");
        let committed = false;
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => {
          const out = commitTravel(l, values.id!, values.revision!, now);
          committed = out.committed;
          return out.ledger;
        });
        return { request: ledger.requests.find((r) => r.id === values.id), committed };
      }
      case "expired": {
        const hours = values.hours !== undefined ? Number(values.hours) : holdHours();
        if (!Number.isFinite(hours) || hours < 0) throw new Error(`--hours must be a number >= 0, got ${values.hours}`);
        return { requests: expiredRequests(readJson<Ledger>(path, EMPTY), hours, now) };
      }
      case "log": {
        if (!values.id) throw new Error("usage: ledger.ts log --id X [--text-file F]");
        if (values["text-file"] === undefined) {
          const request = readJson<Ledger>(path, EMPTY).requests.find((r) => r.id === values.id);
          if (!request) throw new Error(`no request ${values.id}`);
          return { log: request.log ?? [] };
        }
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => appendLog(l, values.id!, readFileSync(values["text-file"]!, "utf8").trim(), now));
        return { log: ledger.requests.find((r) => r.id === values.id)!.log };
      }
      case "monitor":
        return monitor(readJson<Ledger>(path, EMPTY), now);
      case "pipeline":
        return pipeline(readJson<Ledger>(path, EMPTY), now, readJson<{ handle: string }[]>(file("blocked.json"), []).map((b) => b.handle));
      case "history": {
        if (handle === undefined) throw new Error("usage: ledger.ts history --handles-file F");
        return { requests: historyFor(readJson<Ledger>(path, EMPTY), handle) };
      }
      case "pending":
        return { requests: pendingOwnerList(readJson<Ledger>(path, EMPTY)) };
      case "cleanup":
        return { requests: cleanupList(updateJson<Ledger>(path, EMPTY, (l) => discardStaleOffers(l, now, 15 * 60_000))).map((r) => ({ id: r.id, holdCleanup: r.holdCleanup })) };
      case "reminders": {
        const lead = values["lead-min"] !== undefined ? Number(values["lead-min"]) : reminderLeadMin();
        if (!Number.isFinite(lead) || lead <= 0) throw new Error(`--lead-min must be a number > 0, got ${values["lead-min"]}`);
        return { requests: dueReminders(readJson<Ledger>(path, EMPTY), now, lead) };
      }
      default:
        throw new Error("usage: ledger.ts find | add | save | update | promote-offer | discard-offer | cleanup-remove | set-travel | stage-travel | commit-travel | expired | pending | pipeline | monitor | history | log | cleanup | reminders");
    }
  });
}
