# Meetly — Design

Date: 2026-09-26 · Status: approved by the owner; reviewed before the plan

**Contextual request update (#58):** The original unmatched-group and public
detail-question rules below are superseded by `meetly-group`, "Owner request
in an existing group" and "Meeting format". An explicit owner request can
start scheduling in a verified existing group without a ledger entry.
Research context first and clarify genuinely missing details privately with
the owner; guest approval and calendar override rules remain in force.

## Objective

Meetly is an OpenClaw agent on Plow that schedules appointments on the owner's
behalf without waiting for them, then notifies them in a Plow DM. It has two
entry points:

- **Inbound.** Every 5 minutes, it reads the owner's new iMessages through
  Latch. When someone tries to schedule something with the owner, it opens a
  Plow group (owner + the person), offers available times from the owner's
  Google Calendar, holds those times on the calendar, and books the event when
  the person chooses one.
- **Owner request.** The owner asks in a DM ("schedule lunch with Patrick
  next week, you can override Weekly Claw"); Meetly finds the contact, honors
  the request's constraints, and guides the same group conversation.

In any message to third parties, Meetly speaks as the owner's assistant, in
the third person ("Jean is available…"), never in the owner's voice.

**Inbound success:** someone messages the owner "want to grab coffee next
week?" on iMessage; within ~10 minutes, that person receives 3 actual
available times in a Plow group; they choose one; the event appears on the
owner's Google Calendar, the other holds are removed, and the owner receives a
summary in a DM.

**Owner-request success:** the owner writes in a DM "schedule coffee with Ana
Thursday or Friday morning"; Meetly opens a group with Ana offering only
available times on Thursday/Friday morning, in the third person, and books
when she chooses.

## Decisions made with the owner

| Topic | Decision |
|---|---|
| Base | Variant of the `plow-openclaw-agent` image (`FROM base@digest`), without forking `boot/` and `plugin/` |
| Poll scheduling | Native OpenClaw cron, an agent turn every 5 minutes (uses LLM), like Founder Times |
| Script language | TypeScript executed directly by Node ≥ 24.16 (`node x.ts`), no build |
| Create the group | Automatic for any sender (contact or not), with spam filtering; notify the owner afterward |
| Book the event | Automatic when the person chooses; notify the owner afterward |
| Availability window | Set by the owner during setup, in the first DM; applies to all subsequent scheduling |
| Owner request | The owner can ask in a DM; request constraints (days, time, location, duration, events that may be overridden) apply only to that request |
| Voice | Always third person, as the owner's assistant. Never "I am available" |
| Holds | Offered times become tentative events on the owner's calendar; unchosen ones are deleted; after 48 hours without a response, all are deleted |
| Name | Meetly (`AGENT_ID=meetly`, `meetly-` prefix for crons and skills) |

## Workspace references

- `plow-openclaw-agent` @ `1e73c82` (OpenClaw 2026.9.6): base image, the
  "Building a variant image" section of the README; `plow_start_thread` tool
  (group with the owner + phone numbers, `trusted: true`, returns the chat
  uid); `tools.alsoAllow` includes `exec`; default model
  `plow/z-ai/glm-5.2` with fallback `plow/anthropic/claude-sonnet-5`;
  `prompt/AGENTS.md` is rendered at boot from `/opt/plow/prompt/AGENTS.md`.
- `the-founder-times-openclaw-agent`: `cron_backend.py` and
  `register_crons.py` (idempotent cron registration, which Meetly ports to
  TypeScript), `owner_chat.py` (finds the owner's DM through `/v1/agents/me`,
  without caching), setup driven by a gate + skill.
- `aha-openclaw-agent`: TypeScript style (no enums or parameter properties,
  injectable dependencies in tests).
- OpenClaw cron CLI (2026.9.x): `cron add|edit|rm|list --all --json`,
  `--every`, `--session isolated`, `--no-deliver`, `--timeout-seconds`,
  `--tools`, `--light-context`, `--disable/--enable`, `--trigger-script`.
  The cron service records `runningAtMs` and does not start a job that is
  already running.
- Mac Latch skills: `plow-messages` (`search --after-rowid`, `unreplied`,
  `thread`, `chats`), `contacts`, `google-workspace` (`plow-gog calendar
  calendars | events | freebusy | conflicts | create | update | delete`),
  `imessage`.

## 1. Structure

```
meetly-openclaw-agent/
  Dockerfile              FROM base@digest; ENV AGENT_ID/AGENT_NAME/AGENT_BLURB;
                          COPY prompt/ and skills/
  compose.yml             local execution (build: ., env_file ./plow-credentials,
                          state volume, dev-dashboard as in the base)
  package.json            "type": "module"; devDependencies typescript, @types/node;
                          scripts test (node --test) and typecheck (tsc --noEmit)
  tsconfig.json           erasableSyntaxOnly, noEmit, allowImportingTsExtensions,
                          module/moduleResolution nodenext, strict
  .github/workflows/check.yml   typecheck + tests
  prompt/AGENTS.md        base prompt, unchanged, + "Meetly" section
  skills/
    meetly-setup/SKILL.md   setup questions, in order, and how to save them
    meetly-poll/SKILL.md    steps for the 5-minute turn
    meetly-group/SKILL.md   owner request, guide the group, holds, booking
    meetly/scripts/
      paths.ts             state directory (MEETLY_HOME, default /var/lib/plow/meetly)
      store.ts             atomic JSON (tmp + rename) + per-file lock
      config.ts            config types and validation
      setup-status.ts      CLI: SETUP_NEEDED + next question, or READY
      record-setup.ts      CLI: saves a setup answer; --done finalizes
      owner-chat.ts        CLI: prints the owner's DM chat uid (/v1/agents/me)
      cursor.ts            CLI: get | set | fail | ok
      ledger.ts            CLI: find | add | update | expired | cleanup
      busy.ts              normalizes plow-gog output into busy intervals
      slots.ts             CLI: available times from busy + config + constraints
      cron-backend.ts      wrapper for `openclaw cron` (list/add/edit/rm/enable/disable)
      register-crons.ts    CLI: reconciles meetly-* jobs with the spec; --pause/--resume
  tests/*.test.ts         node --test
  checks/manual-scenarios.md   end-to-end validation checklist
```

Code rules: erasable TypeScript only (no `enum`, `namespace`, or parameter
properties); sibling imports use the `.ts` extension; every CLI prints JSON
on one line to stdout and errors to stderr with a non-zero exit code; pure
functions are separated from the CLI for testing; `now`, `fetch`, and the
process runner are injectable.

## 2. Flows

### 2.1 Setup (owner's first DM)

1. The Meetly section of the prompt says: in the owner's DM, before anything
   else, run `node /opt/plow/skills/meetly/scripts/setup-status.ts`.
2. `SETUP_NEEDED` → load `meetly-setup` and ask the next question, one per
   message:
   1. what to call the owner in messages to third parties (e.g. "Jean")
   2. time zone (IANA, e.g. `America/Sao_Paulo`)
   3. available days of the week
   4. time window (e.g. 09:00–18:00)
   5. default duration (min)
   6. horizon (how many days ahead to offer)
   7. which calendars count as busy. The agent lists `plow-gog calendar
      calendars` and suggests the `selected` ones; the `primary` calendar of
      the default account is always included, because that is where holds go.
3. Each answer becomes `record-setup.ts --field X --value Y`. The script
   validates it (valid IANA time zone, non-empty days, `HH:MM` window with
   start < end, duration 15–240, horizon 1–30, non-empty calendars) and
   prints the next question or an error. The draft is stored in
   `config.draft.json`.
4. For the last answer, `record-setup.ts --done` moves the draft to
   `config.json` with `setupDoneAt` and runs `register-crons.ts`. The agent
   confirms in one line that Meetly is active and summarizes the configuration.
5. `READY` → normal conversation. The owner can change any field later
   ("change my window to 10–17"): `record-setup.ts --field ... --value ...`
   writes directly to `config.json` with the same validation.
6. "Pause Meetly" / "resume" → `register-crons.ts --pause` / `--resume`.

Defaults that are not asked: minimum lead time of 2 hours, 3 times per offer,
48-hour hold expiration.

### 2.2 Poll (cron `meetly-poll`)

Registered as `openclaw cron add --name meetly-poll --every 5m --session
isolated --no-deliver --timeout-seconds 600 --message "<poll prompt>"`, with
no `--model` (inherits the base default and follows its updates). The poll
prompt only says to load the `meetly-poll` skill and follow it:

1. No `config.json` → exit (setup has not been completed).
2. `cursor.ts get` → `N`. If there is no cursor (first run): fetch the latest
   rowid, save it, and exit—do not scan history.
3. Latch: `plow-messages search --after-rowid N --order asc --limit 50`
   (see spike 1). On failure → `cursor.ts fail` and exit (section 6).
4. Group messages by sender (`sender`), direct chats only. For each sender,
   decide using the context from `thread --handle` (last ~20 messages):
   - Is this a request to schedule something with the owner? Discard short
     codes, verification codes, marketing, automated messages, and
     conversations that only mention an already-booked appointment.
   - **Is the owner already handling it?** If there is a message from the
     owner (`is_from_me = 1`) in that conversation after the request, Meetly
     does not join in.
   - Is there an open `offered` request for this handle (`ledger.ts find
     --handle`)? Do not open another group.
   - Did the person suggest times ("Tuesday at 3 pm?")? Save them as a preference.
5. For each new request:
   1. Resolve the person through `contacts`: name and phone number. If the
      sender has only an email (Apple ID) and no phone number in contacts, a
      group cannot be opened; notify the owner in a DM and continue.
   2. Availability: use Latch `plow-gog calendar events` on the configured
      calendars, from now through the horizon → `busy.ts` → `slots.ts` (with
      the person's preferences as constraints, if any; if none fit, offer
      the next available times and say the suggested time does not work).
   3. Create holds (2.5).
   4. `plow_start_thread` with the phone number. Opening in the third person,
      in the person's language: who Meetly is, whose assistant it is, the
      detected topic, and the 3 times with weekdays (do not make up that the
      owner asked).
   5. `ledger.ts add` with `origin: inbound`, `sourceRowid`, `chatUid`, topic,
      offered times, and hold ids.
   6. `owner-chat.ts` → `message send` to the owner's DM: who the group was
      opened with, the topic, and the times held.
6. `cursor.ts set <rowid>`: the run processes messages in ascending order;
   if processing a sender fails midway, save the rowid before that sender's
   first message and stop—the next run resumes from there. On success, also
   clear `failingSince` (`cursor.ts ok`).
7. Maintenance:
   - `ledger.ts expired --hours 48` → for each request: delete its holds
     (2.5), run `ledger.ts update --status expired`, tell the group the times
     have been released, and notify the owner.
   - `ledger.ts cleanup` → retry deleting holds that previously failed.
8. Nothing new and nothing expired → exit without sending a message.

### 2.3 Owner request (DM, normal turn)

When the owner asks in a DM to schedule with someone, the Meetly section of
the prompt says to load `meetly-group` (the "Owner request" part):

1. Resolve the person through `contacts`, including all handles. If more than
   one contact matches, or there is no phone number, ask the owner which one
   and end the turn.
2. Extract from the request: topic, days, time range, duration, location,
   and which events the owner has allowed to be overridden. Missing details
   come from config.
3. Allowed events: find events with that name in `calendar events` over the
   horizon (all instances, if recurring) and pass their ids to
   `slots.ts --allow-overlap`. If there is no event with that name, tell the
   owner and proceed without allowing an override.
4. `busy.ts` → `slots.ts` with the constraints. If no times satisfy them,
   tell the owner which constraint is blocking availability and suggest
   loosening it; do not open a group.
5. If `ledger.ts find --handle` returns an open request, reuse the group and
   offer new times there instead of opening another one.
6. Create holds (2.5); only here is `--confirm-conflict` allowed, and only
   for times overlapping events the owner allowed to override.
7. `plow_start_thread` with a third-person opening ("Hi Patrick, this is
   Meetly, Jean's assistant. He wants to schedule lunch with you. Jean is
   available Tue 9/29 at 12 pm, Wed 9/30 at 12 pm, or Thu 10/1 at 12 pm.
   Which works best?"); `ledger.ts add --origin owner` with the constraints
   and `allowOverlap`.
8. Reply to the owner in one line: group opened, times offered and held.

From then on, the group follows section 2.4.

### 2.4 Group (normal turn, triggered by a group message)

A group belongs to Meetly when `ledger.ts find --chat <uid>` finds the
request, or, if the chat uid was not recorded (uncertain delivery), when the
group has exactly the owner + one handle with an open request (`find
--handle`). In this case, the Meetly section of the prompt says to load
`meetly-group`:

- **The person chooses a time** (or says "the first one works"):
  1. Turn the chosen hold into the final event with `plow-gog calendar
     update` (title without "Hold:", location, the person as a guest if
     `contacts` has their email, `--send-updates all`). If the hold no longer
     exists, use `calendar create` with the same details.
  2. Only then, delete the other holds.
  3. Confirm in the group (day, time, location; invitation sent, if applicable).
  4. `ledger.ts update --status booked --event <id>`.
  5. Notify the owner in a DM.
- **The person asks for another day/time** → delete current holds → `slots.ts`
  constrained to what they said (and the owner's original constraints, if
  `origin: owner`) → create new holds → offer again; reset `offeredAt`.
- **The person asks for a time that is unavailable** → say the owner has
  "another commitment" then, without details, and offer alternatives.
- **Conflict while booking** (the calendar changed): if the conflicting
  event is in `allowOverlap`, retry the complete command with
  `--confirm-conflict` and mention the overlap in the notice to the owner;
  any other conflict → do not override it and offer new times.
- **The person declines** → delete holds → `ledger.ts update --status
  dropped` → notify the owner.
- **The appointment is already booked and the person wants to change it** →
  out of scope for v1: Meetly says it will notify the owner and does so.
- **The owner writes in the group** → follow the owner's instruction (e.g.
  "book Tuesday"), including allowing a conflict.

### 2.5 Holds

- Each offered time becomes an event on the `primary` calendar of the default
  account (`plow-gog accounts` → default): `plow-gog calendar create primary
  --summary "Hold: <topic> with <name>" --from … --to … --send-updates none
  --account <default>`, with no guests, opaque. Since the default account's
  `primary` calendar is always included in configured calendars,
  `slots.ts` for another concurrent request already sees the hold as busy.
- Hold creation is conflict-gated: if a new conflict occurs, replace that
  time with the next available one; if there is no replacement, offer fewer
  times.
- The id and account for each hold are stored in the ledger. Meetly only
  deletes (`plow-gog calendar delete <id> --send-updates none --account
  <account>`) events whose ids are recorded in the ledger as its holds—never
  any other event.
- If deletion fails, the id is added to `holdCleanup` in the ledger; the poll
  retries on every run (section 2.2, step 7).

## 3. State (`/var/lib/plow/meetly/`)

- `config.draft.json`: setup draft in progress.
- `config.json`:
  `{ ownerName, timezone, days: ["mon",…], windowStart: "09:00", windowEnd:
  "18:00", durationMin, horizonDays, calendars: [{ account, id }],
  defaultAccount, setupDoneAt, paused?: boolean }`.
- `cursor.json`: `{ rowid, updatedAt, failingSince?, warnedAt? }`.
- `ledger.json`: `{ requests: [Request] }`, where

  ```
  Request = { id, origin: "inbound" | "owner", handle, name?, sourceRowid?,
              chatUid?, topic, location?, durationMin,
              constraints?: { days?, after?, before? },
              allowOverlap?: [eventId],
              offered: [{ start, end, holdId?, account }],
              status: "offered" | "booked" | "dropped" | "expired" | "cancelled",
              eventId?, holdCleanup?: [{ holdId, account }],
              offeredAt, createdAt, updatedAt }
  ```

Every write is atomic (temporary file + `rename`), and ledger/cursor
read-modify-write operations happen under a lock (`mkdir <file>.lock`, stale
after 60 seconds), because the poll and group turns can run simultaneously.
Everything is stored in the state volume, so it survives restarts and
rebuilds. The owner's chat uid is not stored: `owner-chat.ts` queries
`/v1/agents/me` on each use, like `owner_chat.py`.

## 4. `busy.ts` and `slots.ts`

**`busy.ts`** accepts `plow-gog calendar events` output (compact fan-out
format: `startLocal`, `endLocal`, `allDay`, `transparency`, `declined`, `id`,
`account`; or one account's JSON) and returns
`{ busy: [{ start, end, id, account }], unknownAfter?, degraded }`:

- `transparency: transparent` and `declined: true` do not count as busy.
- An opaque all-day event occupies the entire day; a transparent one does
  not count.
- `truncated: { after }` or an account returning exactly `--max` items:
  `unknownAfter` is the earliest of those points; after it, availability is
  unknown, not free.
- An account in `degraded` is included in `degraded` and has no coverage.

**`slots.ts`** accepts busy intervals, config, `now`, and constraints
(`--day`, `--after`, `--before`, `--duration`, `--allow-overlap <id>…`,
`--count`, `--exclude <iso>…`) and returns
`{ slots: [{ start, end, dayOfWeek, label }], unknownAfter?, degraded }`:

- Only config days and time window, in the config time zone (including
  daylight saving time); starts on 30-minute boundaries, at least 2 hours
  after `now`; ends within the window.
- Does not overlap any busy interval, except ids in `--allow-overlap`.
- Does not offer a time that ends after `unknownAfter`; in that case, passes
  `unknownAfter` through so the agent knows the rest was not read.
- Spreads times across different days when possible, preferring the soonest.
- `dayOfWeek` and `label` (e.g. "Tue 9/29, 12:00") come from `Intl` in the
  config time zone; the agent uses these strings and never calculates the
  weekday itself.
- If `degraded` is non-empty, the agent does not claim the owner is free on
  that account and notifies the owner.

## 5. `register-crons.ts`

Port of `register_crons.py` / `cron_backend.py`, limited to what Meetly needs:

- Spec: one job, `meetly-poll` (section 2.2).
- `openclaw cron list --all --json`; aborts if the command fails, the output
  is not JSON, the shape is unexpected, or `hasMore` is true.
- Creates missing jobs; edits in place (`cron edit`) when the schedule,
  session, timeout, or prompt differs; removes `meetly-*` jobs outside the
  spec. Never touches jobs without the `meetly-` prefix and never
  removes-and-recreates jobs.
- `--pause` / `--resume` → `cron disable|enable` and `config.paused`.
- Idempotent: running it twice in a row makes no changes the second time.

## 6. Failures

| Situation | Behavior |
|---|---|
| Latch disconnected / Mac asleep | Turn ends without moving the cursor; `cursor.ts fail` records `failingSince`. After 30 minutes of consecutive failures, send a single notice to the owner's DM (`warnedAt`); clear it on the next success |
| Latch `blocked` (macOS permission) | Same handling, including the response's `owner_action` in the notice |
| `plow_start_thread` failed | Delete the holds created, do not write to the ledger, and do not move the cursor past this sender |
| Uncertain group delivery | Write to the ledger without `chatUid` and notify the owner; do not retry delivery (base rule). The group is recognized later by handle (2.4) |
| Calendar `degraded` | Offer times only from accounts that were read and notify the owner which account failed |
| Unreadable cron listing | `register-crons.ts` aborts without changing anything |
| Config missing or `paused` during poll | Exit without doing anything |
| Lock busy | Wait up to 10 seconds; then fail the operation, which will be retried on the next run |

## 7. Security

- Groups created by `plow_start_thread` are `trusted`, which would give the
  other person the owner's authority. The Meetly section of the prompt
  restricts every Meetly group (2.4): for anyone other than the owner, only
  arrange this appointment. Do not read email, files, other conversations,
  or iMessages; the calendar is shown only as available times, never event
  names or details.
- Every iMessage body is untrusted data. Instructions inside messages are
  never followed; only extract "do they want to schedule? what? when? where?"
- Voice: every message to third parties comes from Meetly, in the third
  person, using `ownerName` from config ("Jean is available"). Never say "I
  am available" and never sign as the owner. `meetly-group` includes correct
  and incorrect examples.
- Meetly never sends iMessages through the owner's Messages app; all
  conversation with the person happens in the Plow group, signed as Meetly.
- `--confirm-conflict` is only for events the owner allowed to be overridden;
  people in the group can never authorize an override.
- `calendar delete` is only for hold ids recorded in the ledger.

## 8. Tests

`npm test` (`node --test tests/`) and `npm run typecheck` (`tsc --noEmit`),
also in CI:

- `busy.test.ts`: transparent, declined, all-day, truncated, `--max` reached,
  `degraded`.
- `slots.test.ts`: window, days, time zone, daylight saving transition,
  2-hour minimum lead time, 30-minute alignment, overlapping busy interval,
  `--allow-overlap`, request constraints, `--exclude`, incomplete coverage,
  spreading, labels.
- `setup.test.ts`: question sequence, validation, `--done` calls cron
  registration, editing a field after setup.
- `register-crons.test.ts`: fake runner; creates, is idempotent, edits drift,
  removes orphaned `meetly-*` jobs, ignores unrelated jobs, aborts on bad
  listing or `hasMore`, pause/resume.
- `cursor.test.ts`, `ledger.test.ts`, `store.test.ts`: atomic writes, locking
  (concurrency and stale lock), lookup by handle and chat, `expired`,
  `cleanup`.
- `owner-chat.test.ts`: fake fetch; one DM, none, more than one.
- `prompt.test.ts`: `AGENTS.md` contains the unchanged base prompt (compared
  with a pinned copy) and the Meetly section; each skill has valid frontmatter
  and only references scripts that exist.

End-to-end validation in `checks/manual-scenarios.md`: `plow-agents mint`,
`docker compose up --build`, setup via DM, request from another number via
iMessage, verify the group, holds, selection, event, and notices; owner request
via DM with an allowed event; expiration with a shortened timeout
(`MEETLY_HOLD_HOURS=0.1`).

## 9. Spike before implementation

1. **iMessage read approval.** Call `plow-messages search --after-rowid N`
   twice with different values of `N` and see whether Latch asks for approval
   again. If it asks on every run, plan B: `plow-messages unreplied` (fixed
   arguments) + `thread --handle`, deduplicated by the ledger and
   `sourceRowid`.
2. **Calendar write approval.** Check whether `calendar create`, `update`,
   and `delete` ask for approval on the Mac every time, and whether
   `plow-gog calendar` can be approved once. If every write requires
   approval, discuss it with the owner before proceeding (no holds, or
   accept Mac approval).
3. **Tools in a cron turn.** Register a test job with `--session isolated`
   and confirm it can see `plow_start_thread`, `message`, `exec`, and the
   Latch MCP tools, and that `exec` inherits `PLOW_API_BASE` /
   `PLOW_AGENT_TOKEN`.
4. **Actual calendar format.** Capture the output of `calendar events`
   (fan-out and one account) and the `--help` output for `create`, `update`,
   and `delete`, and save them as fixtures (without real data) for `busy.ts`
   tests and the skills.

The results determine poll step 3 and whether holds are retained; the rest of
the design does not change.

## Owner cancellation and rescheduling

An explicit owner instruction in their DM authorizes cancelling or moving
the matching meeting. `owner-events.ts` returns only title, id, account,
calendarId and times; incomplete calendar reads are reported to the owner.
Resolve the booked request by event id and account, and mutate that source
calendar. Cancellation closes the request as `cancelled`; moving reuses the
booking recorder. Notify the participant in the linked group, then confirm
to the owner. A failed post-calendar step is retried once and reported to the
owner without suppressing the participant notification. The detailed flow
is maintained in `skills/meetly-group/SKILL.md`, "Owner cancels or moves".

## Out of scope (v1)

Requests originating from email; iMessage groups (direct chats only); multiple participants in one
request; reminders before the event; chasing the person before the 48-hour
deadline; using cron's `--trigger-script` to skip the LLM when there are no
new messages (future optimization if cost becomes a concern).
