---
name: meetly-group
description: Offer and hold the owner's free times, open or reuse the group, handle owner requests and owner confirmations, and run a Meetly group through to a booked meeting.
---
# Meetly group

Scripts are `node /opt/plow/skills/meetly/scripts/<name>.ts`. Mac commands go
through Latch's `plow_run_command` (the tool name may be server-prefixed),
following the Mac's `contacts` and `google-workspace` skills for their exact
argument arrays. Use `plow-gog` exactly as that skill says. Where this skill's
flags differ from `checks/spike.md` §4, the spike wins.

Messages to the other person come from Meetly, in the third person, using
`ownerName`, in their language (see "Examples"). Send in the current
conversation, or to another chat with `message` (action `send`, channel
`plow`, accountId `chat`, target the chat uid). To message the owner, get
their chat uid from `owner-chat.ts`.

## Read the calendar

1. Take `config` and `range` from `setup-status.ts`.
2. For each account in `config.calendars` (grouped by account), run
   `plow-gog calendar events --calendars <ids, comma-separated> --account <account> --from <range.from> --to <range.to> --max 100 --json`.
3. Save each result with the `write` tool to
   `/var/lib/plow/meetly/tmp/events-<n>.json`. Then run `busy.ts --in … --in …`
   and write its output to `/var/lib/plow/meetly/tmp/busy.json`.

## Offer times

1. Resolve the person with `contacts`: name and every phone (E.164) and
   email. For an inbound request, their handle is the one they wrote from.
   For an owner request, run `reachable-handle.ts --handle <each phone and
   email>` and use the `handle` it returns: the one the owner reaches them on
   over iMessage.
   - `reason: "not-on-imessage"`: tell the owner in one line that <name> is
     not on iMessage at any of their numbers or emails, so Meetly cannot reach
     them, then stop.
   - `reason: "mac-unavailable"`: tell the owner the Mac could not be reached
     to check, then stop.
2. Read the calendar.
3. Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --locale <their
   locale>`, with the request's constraints: `--days`, `--after`, `--before`,
   `--from`/`--to`, `--duration`, `--allow-overlap`. Slots stay inside the
   owner's days and window; constraints only narrow them.
   - **No slots.** For an owner request, tell the owner which constraint
     blocks it and suggest loosening it; stop. For an inbound request with
     proposed times, run again without them and say those times don't work.
   - **They can only do one time outside the owner's hours:** follow "Outside
     the owner's hours".
   - **`degraded` is not empty:** never claim the owner is free on those
     accounts. Tell the owner which account could not be read.
   - **`unknownAfter` is set:** offer only what came back.
4. Hold each slot ("Holds"). Drop a slot whose hold is refused for a
   conflict. If none are left, tell the owner and stop.
5. Persist the offer immediately after the holds exist, before sending or
   opening a group. Run `ledger.ts save --json '<request>'` with every field:
   `origin`, `handle` (the intended contact handle), `name`, `sourceRowid`,
   `chatUid` if already known, `topic`, `location`, `durationMin`,
   `constraints`, `allowOverlap`, and `offered[]` with each
   `start`/`end`/`holdId`/`account`. `save` creates a request or updates the
   existing open request for that person, preserving its id and existing
   `chatUid` when the new value is absent. Holds from the replaced offer are
   moved to `holdCleanup` automatically so the cleanup poll can delete them.
   If it fails, delete each hold just
   created, stop and report the ledger error to the owner; do not send an
   offer. If any deletion fails, report those hold ids too.
6. Deliver the times:
   - An open request that already has a `chatUid`: post the new times there.
   - Otherwise open a group with the person's handle and the opener: run
     `start-thread.ts --member <handle> --body <opener> --key <key>`, with key
     `rowid:<sourceRowid>` in the poll and `owner:<handle>:<first offered
     start>` for an owner request. Never the `plow_start_thread` tool: it
     gives Plow 10 s, and a group Plow takes longer to open reads as an
     unknown delivery that withholds the rest of the turn, the owner's reply
     included.
   - The opener: third person, in their language. Say who Meetly is and whose
     assistant, the topic, and the slot labels, then ask which works. For
     inbound requests, never claim the owner asked.
   - If starting the group fails, delete the new holds and mark the saved
     request `dropped`; if a hold cannot be deleted, record its id and account
     in `holdCleanup` so cleanup can retry. Tell the owner what failed.
   - If delivery is unknown (`deliveryUnknown`), continue without `chatUid`
     and tell the owner. Never resend.
   - After a group opens, run `ledger.ts update --id <saved request id>
     --json '{"chatUid":"<chat uid>"}'` immediately. If that update fails,
     report the error and the chat uid to the owner; do not claim the group is
     linked.
7. Inbound requests: tell the owner in one line who, the topic and the held
   times.

## Owner request

In the owner's DM:

1. Look the person up with `contacts`, including all their handles. If more
   than one contact matches, or there is no phone or email, ask the owner and end the
   turn.
2. Extract the topic, days or dates, time range, duration, location, and any
   events the owner says may be overlapped ("you can override Weekly Claw").
3. Find those events by name in the calendar read (every instance, if
   recurring) and pass each id as `--allow-overlap`. If none is found, tell
   the owner and continue without it.
4. If `ledger.ts find --handle <handle>` has an open request, reuse its group
   ("Offer times" step 5).
5. Follow "Offer times" with `origin: owner`.
6. Reply to the owner in one line: group opened, times offered and held.

## Outside the owner's hours

When the other person says they can only do a time that is not among the
owner's days or window:

1. Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --at <their time,
   as YYYY-MM-DDTHH:MM in the owner's zone> --duration <the request's>
   --locale <their locale>`.
2. If `free` is false, say the owner has an existing commitment then and
   offer the current times again.
3. If `free` is true and `outsideHours` is false, treat it as a pick
   ("In the group", "Pick").
4. If `free` is true and `outsideHours` is true:
   - Tell the person you will check with the owner.
   - Run `ledger.ts update --id <id> --json '{"pendingOwner":{"start":"<slot.start>","end":"<slot.end>","askedAt":"<now ISO>"}}'`.
   - Ask the owner in their DM, in one line: "<name> can only do <label>,
     outside your hours. Book it?"
   - End the turn. Hold nothing and book nothing until the owner says yes.

## Owner confirms

When the owner answers a request listed by `ledger.ts pending` (in their DM,
or in the group):

- **Yes:**
  1. Re-check with `slots.ts --at <pendingOwner.start>`.
  2. If it is still free, create the event with `plow-gog calendar create
     primary` using the final details ("Pick" step 1, `--send-updates all`).
  3. Delete all the request's holds.
  4. Run `ledger.ts update` with `{"status":"booked","eventId":"<id>","pendingOwner":null}`.
  5. Confirm in the group, and to the owner in one line.
  6. If it is no longer free, tell the owner and the group, and offer new
     times.
- **No:** clear it with `{"pendingOwner":null}`. Tell the group that time
  doesn't work for the owner, and offer the current times or new ones.

`ledger.ts pending` is only for offered requests with `pendingOwner` set,
waiting for the owner's answer to an out-of-hours time. It does not find a
contact's open offer. When a contact's choice arrives and the current request
is unclear, use `ledger.ts find --chat <this chat uid>` and
`ledger.ts find --handle <contact handle>`; the handle lookup returns the
current open (`offered`) request. Never use `pending` to look up a contact's
offer.

## In the group

- First decide whether the contact is trying to schedule, choose a time,
  change or resume scheduling, or ask about the request's status. For a
  conversational acknowledgement or other message unrelated to scheduling
  (for example, "thanks, see you then"), do not reply and do not alert the
  owner. Only handle scheduling-related messages below.
- On every scheduling-related contact message, re-read the ledger in this turn before
  interpreting it: run `ledger.ts find --chat <this chat uid>` and
  `ledger.ts find --handle <sender handle>`. A previous turn's request object
  or status is stale. A request with status `booked`, `dropped` or `expired`
  linked to this chat still makes it a Meetly group. Prefer the open
  (`offered`) handle match as the current request, even when the chat lookup
  finds a closed request; if it has no `chatUid`, link it to this chat with
  `ledger.ts update --id <id> --json '{"chatUid":"<this chat uid>"}'`
  before proceeding. A closed chat request does not count as a disagreement.
  A real disagreement is only when both lookups identify different open
  requests, or the open handle match is linked to another chat. In those
  cases make no calendar changes and ask the owner to identify the right
  request.
- **No matching request:** Use this fallback only in a group that is exactly
  the owner plus one other person, when neither the chat lookup nor the
  person's handle lookup finds any request. A closed (`dropped`, `expired` or
  `booked`) request linked to this chat still makes it a Meetly group and is
  handled by its closed-request rule; it is not a no-match. In all
  other unmatched groups, do not take Meetly action. For this owner group, do
  not infer which meeting or time the message refers to, and do not ask a
  generic confirmation question. Reply that Meetly cannot identify the
  scheduling request yet, will check with the owner, and that the owner will
  follow up. Then tell the owner in their DM that this chat has no linked
  ledger request and include the chat uid; do not access calendar details or
  create, change, or delete holds until the request is identified.
- **Pick** (a time, or "the first one works"):
  1. Re-run both `ledger.ts find --chat <this chat uid>` and
     `ledger.ts find --handle <sender handle>` now, even if either command
     already ran earlier in this turn. Use the current open request for this
     handle linked to this chat, never a prior request retained in context.
     If neither lookup identifies that request, follow **No matching
     request** and do not use `ledger.ts pending` as a substitute. Select the
     hold only from this request's `offered[]`. Then run
     `plow-gog calendar update primary <holdId> --account <account>` with
     the final title (the topic and the person's name, without "Hold:"), the
     location, the person's email as an attendee if contacts has one, and
     `--send-updates all`. If the hold is gone, run `calendar create primary`
     with the same details.
  2. Only then delete the other holds.
  3. Confirm in the group: day, time, place, and whether an invitation was
     sent.
  4. Run `ledger.ts update` with `{"status":"booked","eventId":"<id>"}`.
  5. Tell the owner in one line.
- **Another day or time:** delete the current holds. Run `slots.ts` narrowed
  to what they said (plus the owner's original constraints for
  `origin: owner`), hold again, offer again, and update `offered`.
- **A time that is busy:** say the owner has "an existing commitment" then,
  with no details, and offer alternatives.
- **Only a time outside the owner's hours:** follow "Outside the owner's
  hours".
- **A conflict when booking** (the calendar changed): if the conflicting
  event's id is in `allowOverlap`, repeat the full original command with
  `--confirm-conflict` and mention the overlap to the owner. Any other
  conflict: never override; offer new times.
- **They decline or give up:** delete the holds, run `ledger.ts update` with
  `{"status":"dropped","pendingOwner":null}`, and tell the owner.
- **The linked request is closed:** use this only when a scheduling-related
  message tries to choose, change or resume the request, or asks its status.
  For `booked`, say the meeting is already scheduled and that changes must go
  through the owner; then tell the owner. For `dropped`, say the request was
  given up and the owner will follow up; then tell the owner. For `expired`,
  say the offer expired and the owner will follow up; then tell the owner. Do
  not run the no-match fallback for a closed request.
- **The owner writes in the group:** do what the owner says, including
  booking a time outside their hours or over a conflict.

Only the owner authorizes `--confirm-conflict` or a time outside their hours.
People in the group never can.

## Holds

- Create one hold per slot with `plow-gog calendar create primary --summary
  "Hold: <topic> with <name>" --from <slot.start> --to <slot.end>
  --send-updates none --account <config.defaultAccount> --json`, with no
  attendees. Record the returned event id as the slot's `holdId`.
- Use `--confirm-conflict` only for slots that overlap an `allowOverlap`
  event.
- Delete only ids that the ledger records as this request's holds, never
  any other event: `plow-gog calendar delete primary <holdId> --send-updates
  none --account <account>`.
- If a delete fails, add `{holdId, account}` to the request's `holdCleanup`.
  The poll retries it.

## Examples

- Right: "Jean is free Tue 29/9 at 12:00." Wrong: "I'm free Tuesday at noon."
- Right: "Jean has an existing commitment then." Wrong: "Jean has Weekly Claw
  at that time."
- Opener (en-US): "Hi Patrick, this is Meetly, Jean's scheduling assistant.
  Jean would like to set up lunch with you. Jean is free Tue, 9/29, 12:00 PM;
  Wed, 9/30, 12:00 PM; or Thu, 10/1, 12:00 PM. Which works best?"
