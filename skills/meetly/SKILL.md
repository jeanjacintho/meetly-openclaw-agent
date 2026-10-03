---
name: meetly
description: Reference for Meetly's scripts (state, calendar math, cron, Plow calls). Read it when a meetly-* skill names a script.
---
# Meetly scripts

Run each as `node /opt/plow/skills/meetly/scripts/<name>.ts` with `exec`.
Success prints one JSON line. Failure prints `error: <message>` on stderr and
exits non-zero: report that line; never guess a result. State lives in
`/var/lib/plow/meetly/`.

| Script | Arguments | Prints |
|---|---|---|
| `setup-status.ts` | | `{status:"READY", config, range:{from,to}}` or `{status:"SETUP_NEEDED", next, question, draft}` |
| `record-setup.ts` | `--field F --value V` \| `--done` | before setup `{saved, next, question}`; after `{saved, config}`; `--done` → `{done, config, crons}` |
| `register-crons.ts` | `[--pause \| --resume]` | `{paused, actions}` |
| `cursor.ts` | `get` \| `set <rowid>` \| `hold <rowid>` \| `release` \| `fail` \| `ok` | the cursor `{rowid, held?, …}`; `set` stops below `held` until the ledger has a request with that `sourceRowid`; `fail` → `{failingSince, warn}` |
| `ledger.ts` | `find --handle H` \| `find --chat U` \| `find --event E --account A` | `{request}` or `{request:null}`; `--event` finds the request booked as that calendar event on that account |
| | `add --json '<obj>'` \| `--json-file F` | `{request}` (refused if the person already has an open request) |
| | `save --json '<obj>'` \| `--json-file F` | `{request}` (creates, or replaces the current open offer for that handle while preserving its id and chat link) |
| | `update --id X --json '<patch>'` \| `--json-file F` | `{request}`; patch keys: `status, chatUid, eventId, offered, holdCleanup, name, location, allowOverlap, constraints, topic, pendingOwner, format, locale, booked, meetUrl, roomUrl, reminder, nudgedAt, personNudgedAt, attendeeEmail` (`null` clears `pendingOwner`, `booked`, `meetUrl`, `roomUrl`, `reminder`, `personNudgedAt`) |
| | `expired [--hours N]` \| `pending` \| `cleanup` | `{requests}`; `cleanup` first discards staged offers older than 15 minutes |
| | `promote-offer --id X --revision R` \| `discard-offer --id X --revision R` | settles a staged re-offer (`save` on a request that already has a group stages it as `pendingOffer`): promote makes it current after a successful send, discard keeps the old one after a failed send; the losing offer's holds enter the cleanup queue; `{request, settled}`, with `settled` false when another save replaced that revision |
| | `cleanup-remove --id X --json-file F` | removes one hold ref after its deletion succeeded |
| | `pipeline` \| `monitor` \| `history --handle H` \| `log --id X [--text-file F]` | `pipeline` → `{waitingOnOwner, deliveryUnknown, waitingOnThem, booked, closed}` (items include `delivery: linked\|unknown`; stages `waiting_on_us`, `delivery_unknown`, `sent`, `waiting_on_them`, `confirmed`, `passed`, derived and never stored); `history` → `{requests}` for that person, newest first, with topic, format, location and length; `monitor` → `{ownerWaiting, deliveryUnknown, waitingOnThem}`: unanswered owner approvals after 4 hours and unknown delivery after 1 hour, warned once (`update` with `nudgedAt`); unknown delivery always means check Messages manually and never resend; `log` → `{log:[{at,text}]}`, appending `--text-file` first when given |
| | `reminders [--lead-min N]` | `{requests}`: booked meetings to re-read: a cancellation is caught for any format, a Meet with a link is due (default 10 min before, until 5 min after the start) |
| `blocklist.ts` | `block` \| `unblock` \| `check`, each with `--handles-file F` (a JSON array of aliases) \| `list` | `{blocked}`: the list, or for `check` true if any alias is blocked; `start-thread.ts` checks again immediately before opening a group |
| `event.ts` | `--in F` | `{id, status, start, end, meetUrl}` from a saved `plow-gog calendar create/update/event --json` output |
| `record-booking.ts` | `--id X --event-file F --account A` | `{request, meetUrl, warning?:"no-meet-link"}`: marks the request booked from the event; with `config.zoomRoomUrl` set, a video meeting keeps that room as `roomUrl` and has no missing-link warning |
| `reminder-check.ts` | `--id X --event-file F [--lead-min N]` | `{action:"send"\|"wait"\|"cancelled"\|"no-link"\|"skip", send?:{chatUid, meetUrl, name, locale, time, minutesToStart}}` |
| | `--id X --sent` | `{request}`: the reminder went out; refused if already handled |
| `busy.ts` | `--fetch` (reads the Mac, writes `tmp/busy.json`) | `{file, busy:<count>, degraded, unknownAfter?}` |
| | `--in F [--in F2…] [--max 100]` | `{busy:[{start,end,id,account}], unknownAfter?, degraded}` |
| `owner-events.ts` | `--from <ISO> --to <ISO>` | `{events:[{id,account,calendarId,title,start,end}], degraded}`: the owner's events read on the Mac, cut down to those fields (for the owner cancelling or moving a meeting) |
| `slots.ts` | `--in busy.json [--duration N] [--days mon,thu] [--after HH:MM] [--before HH:MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--allow-overlap ID]… [--exclude ISO]… [--count N] [--locale TAG]` | `{slots:[{start,end,dayOfWeek,label}], unknownAfter?, degraded}` |
| | `--in busy.json --at <ISO or YYYY-MM-DDTHH:MM in the owner's zone> [--duration N] [--allow-overlap ID]… [--locale TAG]` | `{slot, free, reason?: busy\|too-soon\|unknown, outsideHours, degraded}` |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `start-thread.ts` | `--input-file F` (JSON `{"members":[…],"body":"…","key":"request:<id>"}`) | `{chatUid, messageSent:true}` or `{chatUid:null, deliveryUnknown:true}`. After an unknown delivery, running it again with the same `key` and members (only when the owner asks; the opener wording may be regenerated) returns the group if Plow had opened it |
| `contact.ts` | `--handles-file F` (a JSON array with the one phone or email) | `{found:true, handle, name, phones, emails, matches}`, `{found:false, handle}` or `{found:false, handle, reason:"mac-unavailable"}` |
| `reachable-handle.ts` | `--handles-file F` (a JSON array of phones and emails) | `{handle, via:"iMessage"}`, `{handle:null, reason:"not-on-imessage", services}` or `{handle:null, reason:"mac-unavailable"}` |

Notes:

- Anything that came from a conversation or a contact card (handles, emails,
  opener text, log text) reaches a script only through a JSON or text file the
  `write` tool saves under `/var/lib/plow/meetly/tmp/`, named for the
  operation (`<purpose>-<request id, chat uid or message rowid>`), never a
  shared fixed name, and never on the command line: an email can carry shell
  syntax, and two turns must not read each other's file.
- A request's `format` is `meet`, `in_person`, `phone` or `unknown`.
  `meetUrl` only ever holds `https://meet.google.com/xxx-xxxx-xxx`, only on
  a `meet`; the ledger refuses anything else. `roomUrl` only ever holds the
  owner's configured Zoom room (`https://zoom.us/j/...`), also only on a `meet`.
- Booking and reminders read the event from a file of plow-gog's own
  output; never copy an event id, time or link by hand.
- `slots.ts` only offers times inside the owner's days and window. Requests
  only narrow them.
- Use each slot's `label` and `dayOfWeek` as printed; never work out a
  weekday yourself. Pass `--locale` for whoever reads the message (the other
  person's locale, like `pt-BR` or `en-US`, from their language or their
  phone's country code).
- The line sends over iMessage only. A phone that is not on iMessage (an
  Android, an RCS or SMS contact) gets nothing, and Plow still reports it as
  sent. `reachable-handle.ts` asks the owner's Messages archive which of a
  person's handles is on iMessage; use the handle it returns.
- `start-thread.ts` opens every Meetly group, in the poll and for the owner.
  It gives Plow 30 s and reports an unknown delivery without failing the
  turn; the `plow_start_thread` tool gives it 10 s and, on a slow Plow,
  withholds the turn's reply to the owner.
