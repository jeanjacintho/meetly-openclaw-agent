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
| `cursor.ts` | `get` \| `set <rowid>` \| `fail` \| `ok` | the cursor `{rowid, …}`; `fail` → `{failingSince, warn}` |
| `ledger.ts` | `find --handle H` \| `find --chat U` | `{request}` or `{request:null}` |
| | `add --json '<obj>'` \| `--json-file F` | `{request}` (refused if the person already has an open request) |
| | `save --json '<obj>'` \| `--json-file F` | `{request}` (creates, or replaces the current open offer for that handle while preserving its id and chat link) |
| | `update --id X --json '<patch>'` | `{request}`; patch keys: `status, chatUid, eventId, offered, holdCleanup, name, location, allowOverlap, constraints, topic, pendingOwner` (`null` clears it) |
| | `expired [--hours N]` \| `pending` \| `cleanup` | `{requests}` |
| `busy.ts` | `--in F [--in F2…] [--max 100]` | `{busy:[{start,end,id,account}], unknownAfter?, degraded}` |
| `slots.ts` | `--in busy.json [--duration N] [--days mon,thu] [--after HH:MM] [--before HH:MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--allow-overlap ID]… [--exclude ISO]… [--count N] [--locale TAG]` | `{slots:[{start,end,dayOfWeek,label}], unknownAfter?, degraded}` |
| | `--in busy.json --at <ISO or YYYY-MM-DDTHH:MM in the owner's zone> [--duration N] [--allow-overlap ID]… [--locale TAG]` | `{slot, free, reason?: busy\|too-soon\|unknown, outsideHours, degraded}` |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `start-thread.ts` | `--member <+E164 or email> [--member …] --body TEXT --key K` | `{chatUid, messageSent:true}` or `{chatUid:null, deliveryUnknown:true}` |
| `reachable-handle.ts` | `--handle <+E164 or email> [--handle …]` | `{handle, via:"iMessage"}`, `{handle:null, reason:"not-on-imessage", services}` or `{handle:null, reason:"mac-unavailable"}` |

Notes:
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
