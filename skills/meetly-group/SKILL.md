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
`ownerName`, in their language (see "Examples"). Reply in the current
conversation with `message` (action `send`, omit target) or a normal final reply.
The owner is in every meeting thread: confirmations, notifications and
approval asks go there once, where the guest receives them too. From the
owner's main DM, a follow-up to a known meeting thread uses `plow_reply_to`.
An unattended poll has no current conversation and uses `message` with the
known meeting chat uid as its target.
Before every contact-visible message (including an existing-group offer,
booking confirmation, cancellation, or approval follow-up), run
`blocklist.ts check --handles-file <file>` immediately before sending (a JSON array holding `request.handle`, written to a file named for this
request). If
blocked, do not send; tell the owner privately and leave the request and
calendar state unchanged. Run the same check before any calendar command that
notifies the person (`--send-updates all`: booking, moving, cancelling). If
they are blocked, a guest-driven booking stops there; for an owner-directed
cancel or move, use `--send-updates none` and send no group message.

## Read the calendar

Run `busy.ts --fetch`. It reads every calendar in the config on the Mac
itself and writes `/var/lib/plow/meetly/tmp/busy.json`; it prints only
`{file, busy, degraded, unknownAfter?}`. Never run `plow-gog calendar events`
yourself or copy a calendar listing into a file; "Owner cancels or moves" uses
`owner-events.ts` for the same reason. An account in `degraded`
could not be read: `slots.ts` reports it, and you never claim the owner is
free there.

## Offer times

1. Resolve the person. For an inbound request, run `contact.ts --handles-file
   <file with the handle they wrote from>`: that handle is theirs, and `name` is their
   name (when `found` is false, or `name` is null, go on with the handle; a
   missing card never stops the request). For an owner request, resolve them
   with `contacts`: name and every phone (E.164) and email; then run
   `reachable-handle.ts --handles-file <file with each phone and email>` and use the `handle`
   it returns: the one the owner reaches them on over iMessage.
   - If the contact has a phone but no email, say so in your reply to the
     owner: the calendar invitation needs one, and without it the
     confirmation goes to the group only. They can send an email now.
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
   opening a group. Run `ledger.ts save --json-file <file>` (the request, written with the `write` tool) with every field:
   `origin`, `handle` (the intended contact handle), `name`, `sourceRowid`,
   `chatUid` if already known, `topic`, `location`, `durationMin`,
   `constraints`, `allowOverlap`, `format` and `locale` (see "Meeting
   format"), `attendeeEmail` when contacts has one for them, and `offered[]` with each `start`/`end`/`holdId`/`account`; include `holdCleanup`
   when earlier deletes failed. `save` creates a request or updates the
   existing open request for that person, preserving its id and existing
   `chatUid` when the new value is absent. When the request already has a
   `chatUid`, the new times are only staged: its `offered[]` (what the person
   last saw) and their holds stay current, and the result carries
   `pendingOffer.revision`. Otherwise holds from the replaced offer are moved
   to `holdCleanup` automatically so the cleanup poll can delete them.
   If it fails, delete each hold just
   created, stop and report the ledger error to the owner; do not send an
   offer. If any deletion fails, report those hold ids too.
6. Deliver the times:
   - An open request that already has a `chatUid`: post the new times there.
     From the owner's main DM use `plow_reply_to` with that `chatUid` and the
     new times; in the poll use `message` with that chat uid as its target;
     in the group itself reply normally. Say the new times were sent only
     after that send succeeded, and right after it run `ledger.ts
     promote-offer --id <id> --revision <pendingOffer.revision>`: that makes
     the new times current and queues the replaced holds for the cleanup poll.
     If the send fails, run `ledger.ts discard-offer --id <id> --revision
     <pendingOffer.revision>` instead: the old times stay current and the new
     holds are queued, and the cleanup poll deletes whatever the ledger queued,
     here and after a promotion; do not delete them yourself. Tell the owner the
     specific send error and that the old times stand; never say the new
     request was sent. If either command returns `settled: false`, the offer is
     no longer the one staged (the request closed or the poll discarded it):
     delete nothing and say only what the ledger now shows. A `save` on a
     request that already has an offer being sent is refused: tell the owner
     to try again in a few minutes. A staged offer left by a turn that died is discarded by the
     cleanup poll after 15 minutes.
   - Otherwise open a group with the person's handle and the opener: run
     `start-thread.ts --input-file <file>` (JSON `{"members":[<handle>],"body":"<opener>","key":"<key>"}`), with key
     `request:<saved request id>` for every request, so a retry keeps its key
     and a later request gets a new one. Never the `plow_start_thread` tool: it
     gives Plow 10 s, and a group Plow takes longer to open reads as an
     unknown delivery that withholds the rest of the turn, the owner's reply
     included.
   - The opener: third person, in their language. Say who Meetly is and whose
     assistant, the topic, and the slot labels, then ask which works. For
     inbound requests, never claim the owner asked.
   - When `format` is `unknown`, the same opener also asks how they would
     like to meet: Google Meet or in person. When it is `in_person` with no
     `location`, it asks where. Always in that one message, never a second
     one.
   - When the format is `meet` and neither a contact card nor the thread gives
     the person's email, the same opener also asks for it, for the calendar
     invitation. Search contacts and the thread first; never ask for what you
     can find.
   - If `start-thread.ts` fails, tell the owner what it printed and stop:
     never fall back to `plow_start_thread` and never edit a script. Delete
     the new holds and mark the saved request `dropped`; if a hold cannot be
     deleted, record its id and account in `holdCleanup` so cleanup can retry.
   - In a normal (untrusted) chat, guest turns are reply-only: do not run
     scripts or use the owner's calendar. Explain in the thread that the
     owner must approve there. If full guest tools are needed, the owner
     must ask in their main DM to make the group trusted; only there can
     `plow_set_thread_trust` change the group's trust.
   - If delivery is unknown (`deliveryUnknown`), continue without `chatUid`
     and tell the owner in one plain line, in their language: you started the
     group with <name> and Plow did not confirm it, so they should look for it
     in their messages; the holds are kept and the request is saved. Say
     nothing else about delivery: never quote a status code or say you cannot
     confirm anything else. Never resend by another route. Only if the owner
     says the group is not there, or asks you to try again, run
     `start-thread.ts` again with the same `key` and members. The idempotency
     key is based on request identity, so regenerated opener wording still
     resolves to the same group. Link the group it returns as below.
   - After a group opens, run `ledger.ts update --id <saved request id>
     --json '{"chatUid":"<chat uid>"}'` immediately. If that update fails,
     report the error and the chat uid to the owner; do not claim the group is
     linked.
7. The group opener also notifies the owner of who, the topic and the held
   times; do not send a separate DM.

## Owner request

In the owner's DM:

1. Look the person up with `contacts`, including all their handles. If more
   than one contact matches, or there is no phone or email, ask the owner and end the
   turn.
2. Extract the topic, days or dates, time range, duration, location, the
   format ("Meeting format"), and any events the owner says may be
   overlapped ("you can override Weekly Claw").
3. Find those events by name in the calendar read (every instance, if
   recurring) and pass each id as `--allow-overlap`. If none is found, tell
   the owner and continue without it.
4. If `ledger.ts find --handles-file <file with handle>` has an open request, reuse its group
   ("Offer times" step 5).
5. Follow "Offer times" with `origin: owner`.
6. Only after the group opened or the send succeeded, reply to the owner in
   one line: the group opened, or for an existing group the new times sent to
   that group, and the times held. If it failed, reply with the error from
   "Offer times" step 6 instead. When the group offered more than one time,
   end it with the rule, in the owner's language: say "book it" and Meetly
   takes the first option, or name another.
7. When the owner's message only tells you to book or schedule a request of
   theirs that is already open (`origin: owner`), with no time, resolve it in
   the owner's DM with `ledger.ts find --handles-file <file with contact handle>`. Re-read it
   now and require `status: offered` and `origin: owner`; do not look up the
   owner's DM using `find --chat` or use a request retained in context. Book
   its first current offered time through **Owner request pick** below. A
   request someone else made (`origin: inbound`) is approved only in its
   meeting thread: point the owner there and book nothing.

## Pipeline

When the owner asks who they are waiting on, or how their meetings stand,
run `ledger.ts pipeline` and answer in their language, one short line per
person: what the meeting is for, its `stage` and its `nextStep`. Stages:
`waiting_on_us` (an out-of-hours time for the owner to approve),
`delivery_unknown` (no linked group; check Messages manually and never resend),
`sent` (offered less than a day ago), `waiting_on_them` (no
answer in a day or more, with the hours), `confirmed` (booked: day and time;
for a booking with no time recorded: say its time is unavailable), and
`passed` (closed in the past week). The `delivery` field says whether the
request has a linked group; `unknown` never means "never delivered" and never
authorizes a retry. The next step is advice computed from the stage, never a
claim about what happened. State only what the ledger says.
Someone on the do-not-contact list has no stage: `blocklist.ts list`.

## What the log says

Keep a dated log of what happened: after each of these, run
`ledger.ts log --id <id> --text-file <file>` (the one line, saved with the
`write` tool; log text never goes on the command line): the offer was sent (after the
send succeeded), the person picked a time, the booking was recorded, the
meeting was moved or cancelled, the offer expired. Write only what the
calendar or the chat confirmed, never a plan or a guess. Read it back with
`ledger.ts log --id <id>`.

## Do not contact

When the owner says never to contact someone, or to stop, resolve their
Contacts card and block every phone and email alias: save them as a JSON array
with the `write` tool and run `blocklist.ts block --handles-file <file>`.
Contact text never goes on the command line.
Confirm in one line. To take them off, resolve the same card
and pass every alias to `blocklist.ts unblock --handles-file <file>`. In the poll, skip a sender for
whom `blocklist.ts check --handles-file <file>` says `blocked`: no group, no
holds, nothing sent. `start-thread.ts` checks the list again immediately
before its POST, so a new block also stops a group-open race. Never route
around a `do not contact` result.

## Research before proposing

Before proposing times, establish the topic, purpose, attendees, location,
duration and meeting format from the current conversation and the owner's
request. Then check the contact card (`contacts`, `contact.ts`), this person's
recent Plow message thread, and `ledger.ts history --handles-file <file with their handle>`.
For an owner request, also search the owner's relevant email and Plow messages
for the contact and topic, following the Mac's `google-workspace` and
`plow-messages` skills for their exact commands. Keep searches narrow to this
person and scheduling context; use only details that the sources confirm.

Carry forward a prior request's topic, format, location and duration when the
current request is a continuation. Prefer explicit current instructions over
older context. Never ask the other person for something these sources answer,
or that the context already answers ("in person or on video?" when the owner
said video). If a required detail remains unclear, ask the owner privately
before contacting the other person. The owner's goal and intended location
must come from the owner or confirmed history; never infer them from a name or
calendar event title.

## Owner cancels or moves

In the owner's DM, when the owner cancels, moves or clears time ("cancel my
lunch with Ana", "remove all my appointments today", "move the call to 3pm"):

1. Run `owner-events.ts --from <ISO> --to <ISO>` for the owner's range. It
   prints `{events: [{id, account, calendarId, title, start, end}], degraded}`:
   only the title, id, account, calendar and times, read on the Mac, so match
   the owner's words against the titles. Never run `plow-gog calendar events` yourself for
   this. For each event, run `ledger.ts find --event <event id> --account <its
   account>`. An event with no request (or one whose request is not `booked`)
   is not a Meetly meeting: handle it as the owner asked and tell no one. An
   account in `degraded` could not be fully read (it failed, or its listing
   was cut at 100 events): say so, and never claim there was nothing to
   cancel there.
2. Act on the owner's words. Their own instruction that covers the meeting
   ("all", "everything today", the person's name) is the approval: do not ask
   again. Ask once only when the words truly leave it open which meetings
   are meant. When the owner repeats the instruction instead of answering,
   that is the yes.
3. For each booked request, with `<account>` and `<calendarId>` those the
   event was read from (never assume `primary`):
   - **Cancel:** `plow-gog calendar delete <calendarId> <eventId> --send-updates
     all --force --account <account>`. Then `ledger.ts update --id <id>
     --json '{"status":"cancelled","pendingOwner":null}'`. If the delete
     fails, change nothing else, tell the owner and send nothing to the
     group.
   - **Move:** `plow-gog calendar update <calendarId> <eventId> --from <start>
     --to <end> --send-updates all --account <account> --json`, then
     record it as in "Book the event" steps 1 and 2.
   - If a step after the calendar change fails, retry it once in this turn,
     and still send the group message (step 4). If it still fails, tell the
     owner exactly which steps are left and for which meeting. A deleted
     event left `booked` gets no reminder: `reminder-check.ts` reads the
     live event and sees it cancelled.
4. Then tell them in their group (the request's `chatUid`) with
   `plow_reply_to`, in one line, in their language and in the third person: the owner cancelled (or moved)
   the meeting, its day and time, and for a move the new time. Give no
   reason unless the owner gave one to pass on. A Google cancellation email
   is not a message from Meetly: the group message is always sent. With no
   `chatUid`, tell the owner that the person was only notified by the
   calendar.
5. Reply to the owner in one line: what was cancelled or moved, and who was
   told where.

Example (pt-BR): "Oi Ana, o Jean precisou cancelar o almoço de qui., 01/10,
às 12:30."

## Meeting format

`format` is how the meeting happens: `meet` (Meetly creates a Google Meet),
`in_person` (a place), `phone`, or `unknown`. It counts only when the words
say it, from the owner's request or from the other person:

- `meet`: "Google Meet", "Meet", "video call", "videochamada", "online",
  "por vídeo".
- `in_person`: "in person", "presencial", "pessoalmente", or a named place
  ("at Starbucks Paulista", "no escritório"). Put the place in `location`.
- `phone`: "by phone", "por telefone", "call me at <number>".
- Anything else is `config.defaultFormat` when the owner set one, otherwise
  `unknown`, including "call", "ligação", "a quick chat", and "coffee" or
  "lunch" with no place. Never guess from the topic. A Zoom or other link
  someone sends is not `meet`: leave the format `unknown` and put what they
  said in `location`.

What the owner or the other person says about the format always wins over
`config.defaultFormat`. A default of `meet` or `phone` needs nothing more, so
the opener does not ask. A default of `in_person` still asks where.

Pass `locale` with every save: the other person's language tag, the same one
used for `slots.ts --locale`.

An answer that arrives before booking is recorded with
`ledger.ts update --id <id> --json-file <file>` (`{"format":"<format>","location":"<place>"}`)
(drop `location` when there is none). A later answer replaces an earlier
one. Never ask about the format twice in a row: once in the opener, and once
after booking if the pick did not answer it.

## Movable blocks

The owner can list words from the titles of blocks Meetly may offer times
over (`config.movable`). `busy.ts` marks those blocks `movable` without giving
their titles, and `slots.ts` offers times over them; a slot that lists
`overlaps` needs `--confirm-conflict` on its hold and on its booking. The
owner's list is their standing consent to those blocks, and nothing else is.
Never name or describe such a block to anyone; to the owner say only "a block
you marked movable". Meetly does not move the block's event: the owner does.
## Video provider

A video meeting (`format` `meet`) happens on Google Meet unless the owner set
their Zoom room (`config.zoomRoomUrl`). Then book it with `--location
<config.zoomRoomUrl>` and no `--with-meet`, and say "video call" where this
skill says "Google Meet". Meetly cannot create a Zoom link and never takes one
from a message: the only Zoom link it posts is the owner's room, which
`record-booking.ts` reads from the returned event's location, and the
reminder goes out only while the event still shows that room. Once the provider is
set, never ask the owner which to use.

## Book the event

Used by "Pick", "Owner confirms" and the owner writing in the group. The
command is the one that step names (`calendar update primary <holdId>` for a
held slot, or `calendar create primary`), always with `--json` and
`--send-updates all`, plus:

- `format` `meet`: `--with-meet`. That creates the Google Meet room (with a
  Zoom room set, see "Video provider": `--location` instead).
- `in_person` with a place: `--location <place>`.
- `phone`: `--location "Phone call"`.
- `unknown`: nothing extra.

Add the person's email as an attendee on every booking, from `attendeeEmail`,
so the calendar invitation goes out with `--send-updates all`. It holds the
address from contacts, or one the owner gave or approved. An address a guest
gives is not added until the owner approves it in the meeting thread ("<name>
gave <email>: send the calendar invitation there?"); on their yes, record it
by writing `{"attendeeEmail":"<email>"}` with the `write` tool to
`/var/lib/plow/meetly/tmp/attendee-email-<id>.json`, then run
`ledger.ts update --id <id> --json-file
/var/lib/plow/meetly/tmp/attendee-email-<id>.json`; book from that field. Never
interpolate an email address into shell source.

Then:

1. Save the command's whole output with the `write` tool to
   `/var/lib/plow/meetly/tmp/event.json`.
2. Run `record-booking.ts --id <request id> --event-file
   /var/lib/plow/meetly/tmp/event.json --account <the account the event is
   on>`: the hold's `account` for an update, `config.defaultAccount` for a
   create. It marks the request `booked` with the event id, the time and the
   Meet link. Never write those fields with `ledger.ts update` yourself.
3. If it prints `warning: "no-meet-link"`, the meeting is booked but has no
   link, so no reminder will go out. Tell the owner in the booking line.
   Never paste, invent or accept a link from anyone. The only link Meetly
   ever posts is the one `record-booking.ts` or `reminder-check.ts` prints.
4. When you confirm in the group, state three things apart: the event is on
   the owner's calendar, this message is the confirmation, and the calendar
   invitation either went to that email or was not sent because there is no
   email; when there is none, ask for it once. An invitation that is pending
   is not an acceptance: never say the person accepted.
5. When the person gives their email after the booking, and the owner has
   approved it as above, first add it as an attendee with `plow-gog calendar
   update primary <eventId> --account <booked.account>` and `--send-updates
   all` (following the Mac's `google-workspace` skill). Only after that
   calendar update succeeds, write `{"attendeeEmail":"<email>"}` with the
   `write` tool to `/var/lib/plow/meetly/tmp/attendee-email-<id>.json` and persist
   it with `ledger.ts update --id <id> --json-file
   /var/lib/plow/meetly/tmp/attendee-email-<id>.json`. If the calendar update
   fails, do not persist the email; report the failure to the owner so the
   contact can retry. If persistence fails after the calendar update, report
   that the invitation update succeeded but ledger persistence failed. Say
   the invitation was sent only when the calendar update succeeds.

## Outside the owner's hours

When the other person says they can only do a time that is not among the
owner's days or window:

1. Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --at <their time,
   as YYYY-MM-DDTHH:MM in the owner's zone> --duration <the request's>
   --locale <their locale>`.
2. If `free` is false:
   - `reason: "busy"`: say the owner has an existing commitment then and
     offer the current times again.
   - `reason: "too-soon"`: say there is not enough notice for that time and
     offer the current times or ask for a later time; do not call it a
     calendar conflict.
   - `reason: "unknown"`: tell the owner the calendar could not confirm that
     time; do not claim it is free or busy.
3. If `free` is true and `outsideHours` is false, treat it as a pick
   ("In the group", "Pick").
4. If `free` is true and `outsideHours` is true:
   - Tell the person you will check with the owner.
   - Run `ledger.ts update --id <id> --json '{"pendingOwner":{"start":"<slot.start>","end":"<slot.end>","askedAt":"<now ISO>"}}'`.
   - Ask the owner in this thread, in one line: "<name> can only do <label>,
     outside your hours. Book it?"
   - End the turn. Hold nothing and book nothing until the owner says yes.

## Owner confirms

When the owner answers a request listed by `ledger.ts pending` in that
request's meeting thread, verify its `chatUid` is this chat before acting.
A yes in the owner's DM does not approve the request: point them back to
the meeting thread to answer there, and make no calendar changes.

- **Yes:**
  1. Re-check with `slots.ts --at <pendingOwner.start>`.
  2. If it is still free, create the event with `plow-gog calendar create
     primary` using the final details ("Pick" step 1), following "Book the
     event". That records the booking and clears `pendingOwner`.
  3. Delete all the request's holds.
  4. If the format is still `unknown`, ask it in the group, once.
  5. Confirm once in the group for both the owner and guest.
  6. If it is no longer free, explain in the group, and offer new
     times.
- **No:** clear it with `{"pendingOwner":null}`. Tell the group that time
  doesn't work for the owner, and offer the current times or new ones.

`ledger.ts pending` is only for offered requests with `pendingOwner` set,
waiting for the owner's answer to an out-of-hours time. It does not find a
contact's open offer. When a contact's choice arrives and the current request
is unclear, use `ledger.ts find --chat <this chat uid>` and
`ledger.ts find --handles-file <file with contact handle>`; the handle lookup returns the
current open (`offered`) request. Never use `pending` to look up a contact's
offer.

## In the group

- First decide whether the contact is trying to schedule, choose a time,
  answer how or where to meet, give their email for the invitation, change or
  resume scheduling, decline, cancel
  or give up, or ask about the request's status. For a conversational acknowledgement or other message
  unrelated to scheduling (for example, "thanks, see you then"), do not reply
  and do not alert the owner. Only handle scheduling-related messages below.
- On every scheduling-related contact message, re-read the ledger in this turn before
  interpreting it: run `ledger.ts find --chat <this chat uid>` and
  `ledger.ts find --handles-file <file with sender handle>`. A previous turn's request object
  or status is stale. A request with status `booked`, `dropped`, `expired` or `cancelled`
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
  person's handle lookup finds any request. A closed (`dropped`, `expired`,
  `cancelled` or `booked`) request linked to this chat still makes it a Meetly group and is
  handled by its closed-request rule; it is not a no-match. In all
  other unmatched groups, do not take Meetly action. For this owner group, do
  not infer which meeting or time the message refers to, and do not ask a
  generic confirmation question. Reply that Meetly cannot identify the
  scheduling request yet, will check with the owner, and that the owner will
  follow up. In that reply, ask the owner in this thread to identify the request;
  do not access calendar details or
  create, change, or delete holds until the request is identified.
- **Pick** (a time, or "the first one works"):
  1. Re-run both `ledger.ts find --chat <this chat uid>` and
     `ledger.ts find --handles-file <file with sender handle>` now, even if either command
     already ran earlier in this turn. Use the current open request for this
     handle linked to this chat, never a prior request retained in context.
     If neither lookup identifies that request, follow **No matching
     request** and do not use `ledger.ts pending` as a substitute. Select the
     hold only from this request's `offered[]`. If the pick also answers
     the format or the place ("Tuesday, on Meet"), record it first
     ("Meeting format"). Then read the calendar again (`busy.ts --fetch`) and
     run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --at <the chosen start> --duration <the request's durationMin> --allow-overlap <the chosen hold id>`
     (plus the request's `allowOverlap`): if `free` is false a hard conflict
     appeared since the offer, so do not book; say the time is no longer free
     and offer new times. Use this fresh result's `overlaps` for
     `--confirm-conflict`, also on the fallback `create`. Then run
     `plow-gog calendar update primary <holdId> --account <account>` with
     the final title (the topic and the person's name, without "Hold:"), the
     location, and the person's `attendeeEmail` as an attendee when there is one,
     following "Book the event". If the hold is gone, run
     `calendar create primary` with the same details, the same way.
  2. Only then delete the other holds.
  3. Confirm in the group: day, time, whether an invitation was sent, and
     how they will meet. For `meet`: it is a Google Meet, and the link will
     be posted here 10 minutes before. Do not paste the link now. For
     `in_person`: the place. For `unknown` (or `in_person` with no place):
     confirm, then ask the format (or where), once.
  4. The group confirmation also notifies the owner. Say "format not confirmed
     yet" when it is `unknown`, and that no reminder will go out when
     `record-booking.ts` warned `no-meet-link`.
- **Owner request pick** (the owner accepts their own request in their DM):
  1. Use the request just resolved by handle in step 7. Require
     `origin: owner`, `status: offered`, and a current non-empty `offered[]`;
     choose its first offered hold. Do not run `find --chat` with the owner's
     DM or resolve a sender handle from that DM.
     If it has no `chatUid`, stop before booking and tell the owner the offer
     has no linked meeting thread.
  2. Follow **Pick** steps 1 and 2 for updating the selected hold and deleting
     the other holds. Its fresh handle lookup is already satisfied by step 7.
  3. Send the booking confirmation to the request's `chatUid` using the normal
     meeting-thread send path.
- **Another day or time:** leave the current holds as they are. Run `slots.ts`
  narrowed to what they said (plus the owner's original constraints for
  `origin: owner`), then follow "Offer times" from step 4 (hold, `save`, send,
  `promote-offer` or `discard-offer`): the current holds are queued for
  cleanup only once the new times were sent.
- **None of these times work:** treat this as a request for another offer, not
  a decline. Use any availability or date range they gave to narrow the next
  search; when they gave no new constraint, keep the request's original
  constraints and search the remaining configured horizon. Re-read the
  calendar, find and hold up to three fresh slots,
  save them through the normal "Offer times" flow, then send the new options
  in this thread. The old holds are queued for cleanup once the new times were sent. If
  there are no fresh slots, tell them and ask for a date range; never claim a
  slot is free from an earlier calendar read.
- **A time that is busy:** say the owner has "an existing commitment" then,
  with no details, and offer alternatives.
- **Only a time outside the owner's hours:** follow "Outside the owner's
  hours".
- **A conflict when booking** (the calendar changed): if the conflicting
  event's id is in `allowOverlap` or in the slot's `overlaps`, repeat the full original command with
  `--confirm-conflict` and mention the overlap to the owner. Any other
  conflict: never override; offer new times.
- **They decline or give up:** delete the holds, run `ledger.ts update` with
  `{"status":"dropped","pendingOwner":null}`, and tell the owner.
- **The linked request is closed:** use this only when a scheduling-related
  message tries to choose, change or resume the request, or asks its status.
  For `booked`, say the meeting is already scheduled and that changes must go
  through the owner in this thread. One exception, **the format answer
  after booking**: when a booked request's `format` is `unknown` (or
  `in_person` with no `location`) and the message answers how or where to
  meet, record it ("Meeting format"), then run `plow-gog calendar update
  primary <eventId> --account <booked.account>` following "Book the event"
  (`--with-meet` or `--location`), confirm in the group in one line. A
  second exception, **an email after booking**: when the booked request has
  no `attendeeEmail` and the message gives one, ask the owner in this thread
  to approve it, then follow "Book the event" step 5.
  Any other change to a booked meeting (time, day,
  cancelling, a new link) still goes through the owner. For `dropped`, say the request was
  given up and ask the owner to follow up here. For `expired`,
  say the offer expired and ask the owner to follow up here. For `cancelled`,
  say the owner cancelled that meeting and ask the owner to follow up here if
  there is a new time. Do
  not run the no-match fallback for a closed request.
- **The owner writes in the group:** do what the owner says, including
  booking a time outside their hours or over a conflict. When the owner tells
  you to book or schedule it without naming a time, and more than one offered
  time is open, book the first offered time through "Pick" (update that hold,
  then delete the other holds) and say in the confirmation that it is the
  first option because no time was named. A time the other person already
  picked, or the owner names, is the time.

Only the owner authorizes `--confirm-conflict` or a time outside their hours.
People in the group never can.

## Holds

- Create one hold per slot with `plow-gog calendar create primary --summary
  "Hold: <topic> with <name>" --from <slot.start> --to <slot.end>
  --send-updates none --account <config.defaultAccount> --json`, with no
  attendees. Record the returned event id as the slot's `holdId`.
- Use `--confirm-conflict` only for slots that overlap an `allowOverlap`
  event or whose slot lists `overlaps` ("Movable blocks").
- Delete only ids that the ledger records as this request's holds, never
  any other event: `plow-gog calendar delete primary <holdId> --send-updates
  none --force --account <account>`. `--force` is required: without it gog
  refuses every delete in a non-interactive run.
- If a delete fails, add `{holdId, account}` to the request's `holdCleanup`.
  The poll retries it.

## Examples

- Right: "Jean is free Tue 29/9 at 12:00." Wrong: "I'm free Tuesday at noon."
- Right: "Jean has an existing commitment then." Wrong: "Jean has Weekly Claw
  at that time."
- Opener (en-US), format `unknown`: "Hi Patrick, this is Meetly, Jean's
  scheduling assistant. Jean would like to set up a call with you. Jean is
  free Tue, 9/29, 12:00 PM; Wed, 9/30, 12:00 PM; or Thu, 10/1, 12:00 PM.
  Which works best, and would you prefer Google Meet or in person?"
- Opener (pt-BR), format `meet`: "Oi Patrick, aqui é o Meetly, assistente de
  agenda do Jean. O Jean quer marcar um Google Meet com você. Ele está livre
  ter., 29/09, 12:00; qua., 30/09, 12:00; ou qui., 01/10, 12:00. Qual fica
  melhor?" No format question: the request already said Meet.
- Booked, `meet`: "Done: Tue 9/29 at 12:00 PM, on Google Meet. Invitation
  sent. I'll post the link here 10 minutes before." Wrong: pasting the link
  now, or a link someone else sent.
- Reminder: "Patrick, Jean's meeting starts in 10 minutes (12:00 PM). Join
  here: https://meet.google.com/abc-defg-hij"
