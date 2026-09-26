# Meetly

Your scheduling assistant, on a text thread. When someone asks to meet you,
Meetly opens a group with them, offers your free times, holds them on your
calendar and books the one they pick. You hear about it afterwards.

An [OpenClaw](https://github.com/openclaw/openclaw) agent on
[Plow Chat](https://howto.plow.co/). It is one person's assistant: your days,
your hours, your calendars, set once in a short chat.

> **Status:** implemented. The on-Mac checks (`checks/spike.md`) and the
> end-to-end run (`checks/manual-scenarios.md`) are still to be done before
> the first deploy.

## What it is

Every five minutes Meetly reads your new iMessages on your Mac, through
[Latch](https://howto.plow.co/latch). When someone is trying to set something
up with you — "coffee next week?" — it:

1. opens a Plow group with you and that person,
2. offers three free times from your Google Calendar, inside the days and
   hours you allow,
3. holds those times on your calendar so nothing else takes them,
4. books the one they pick, invites them if it knows their email, and
   releases the other holds,
5. tells you in your DM what it did.

It does not wait for you. If you are busy, the meeting still gets booked.

You can also ask it directly: *"set up lunch with Patrick next week — it can go
over Weekly Claw"*. Meetly finds Patrick in your contacts, respects what you
said for that one request, and runs the same group.

Meetly always speaks as your assistant, in the third person: *"Jean is free Tue
29/9 at 12:00"*, never *"I'm free"*. It never texts from your own Messages
account; every conversation with the other person happens in the Plow group,
signed as Meetly.

## What it will and won't do

- **Offers only free time, inside your hours.** Your calendar shows up as free
  slots within the days and hours you set. Anything else is "an existing
  commitment" — never an event name or detail. If the other person can only
  do a time outside your hours, Meetly asks you first and books it only on
  your yes.
- **Holds expire.** No answer in 48 hours: the holds are deleted and the
  group is told the times were released.
- **Overlaps only with your word.** Meetly books over an existing event only
  when you named that event in your request (or said yes in the group). People
  in the group can never unlock a conflict or a time outside your hours.
- **Stays on topic in groups.** The group is for this one meeting. Meetly does
  not read your mail, files or other conversations for the other person.
- **Ignores instructions in messages.** A text that says "ignore your rules"
  is just a text.
- **Skips noise.** Verification codes, short codes, marketing and automated
  senders never get a group. If you already answered the person yourself,
  Meetly stays out of it.

## Setup

The first time you text the line, Meetly asks, one question at a time:

1. the name to use for you with other people,
2. your time zone,
3. which days you take meetings,
4. between which hours,
5. the default meeting length,
6. how many days ahead it may offer,
7. which of your calendars count as busy.

Then it switches on the five-minute check. Change any answer later in plain
words ("make my window 10 to 17"), or say "pause Meetly" / "resume Meetly".

## Install (local)

You need Git, Docker Compose, and
[plow-agents](https://github.com/plow-pbc/plow-agents).

```sh
git clone https://github.com/jeanjacintho/meetly-openclaw-agent.git
cd meetly-openclaw-agent

plow-agents login                 # text the printed code
plow-agents lines                 # pick a free line
plow-agents mint LINE_UID         # writes ./plow-credentials before the first up
docker compose up --build -d
docker compose logs -f agent      # wait for: plow-boot: identity resolved …
```

Text the line you minted; setup starts with your first message. The local
dashboard is at <http://localhost:3001> (anyone who can reach it is admin).

```sh
docker compose down          # stop, keep settings, holds ledger and schedule
docker compose down -v       # wipe the state volume (fresh setup)
plow-agents revoke           # retire the line in plow-credentials
```

`plow-credentials` is gitignored. Do not commit it.

**Apple Silicon.** The base image is published for `linux/amd64` only, and
Docker's emulation on Apple Silicon lacks the `openat2` syscall OpenClaw
2026.9.6 needs: the gateway exits with code 78 ("the Gateway or another SQLite
maintenance command owns this state directory"). Build the base natively from
source once, then add the arm64 override:

```sh
./dev/build-base.sh                                          # tags plow-openclaw-base:1e73c82-local
docker compose -f compose.yml -f compose.arm64.yml up --build -d
```

Images you deploy are unaffected: the Dockerfile's default `BASE_IMAGE` is the
published base, pinned by digest. On a native arm64 build the Agent Index usage
reporter cannot run (the base ships `agentsview` for amd64 only); the agent
itself works.

## Deploy (cloud)

Build and push the image to a registry you control that Plow can pull, then
deploy it by digest:

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

A cloud host injects the credentials; there is no `plow-credentials` file.
The image lists itself on the [Agent Index](https://aiworthusing.com/agent-index)
as `meetly` (`AGENT_ID`, `AGENT_NAME`, `AGENT_BLURB`, `AGENT_RUNTIME` in the Dockerfile) and
reports its token usage through the base's pinned reporter.

## Your Mac: Latch, Messages and Calendar

Run [Latch](https://howto.plow.co/latch) on the Mac that holds your iMessages,
signed in to the same Plow account, with your Google account connected in
Latch. Meetly uses the Mac's own skills: `plow-messages` to read texts,
`contacts` to find people, and `google-workspace` (`plow-gog`) for your
calendar. Chat works without Latch; reading messages and your calendar does
not. If the Mac is asleep or Latch is closed for more than 30 minutes, Meetly
tells you once and picks up where it left off when the Mac is back — no
message is skipped.

## How it runs

- **Image.** A variant of Plow's
  [OpenClaw base image](https://github.com/plow-pbc/plow-openclaw-agent),
  pinned by digest: the base's boot, gateway, Plow channel and reporter, plus
  Meetly's prompt and skills. Nothing of the base is forked.
- **Schedule.** One OpenClaw scheduler job (`openclaw cron`), `meetly-poll`:
  an isolated agent turn every five minutes with no automatic delivery,
  registered by `register-crons.ts` when setup finishes. It lives in the state
  volume and survives restarts and rebuilds.
- **Chat.** Your phone DM is the main session and runs setup. A group Meetly
  opened is recognized from its ledger and handled as that one meeting.
- **Opening groups.** Turns started by a Plow message (your DM, a group) use
  the base's `plow_start_thread`. The scheduled check has no inbound message,
  and the base tool refuses to start a thread there, so the poll uses
  `start-thread.ts`, which makes the same `POST /v1/chats` call (owner plus
  the phone, trusted, idempotency key). If the result is uncertain, it records
  the request without a chat and never sends twice. See `checks/spike.md`.
- **Scripts.** Small TypeScript CLIs in `skills/meetly/scripts/`, run directly
  by the image's Node (`node <script>.ts`, no build): setup, the message
  cursor, the request ledger, busy/free-slot math in your time zone, cron
  registration, the owner-DM lookup and the poll's group start. The model
  decides; the scripts count.
- **State.** `/var/lib/plow/meetly`: `config.json` (your setup),
  `cursor.json` (last message read), `ledger.json` (requests, offered times,
  hold ids). Writes are atomic and locked.

## Known limitations

- Only direct iMessage chats; group chats and email requests are not read.
- One person per request.
- A sender known only by an email (no phone number) cannot get a group; Meetly
  tells you instead.
- Rescheduling or cancelling a meeting that is already booked is left to you.
- If the model provider is unreachable, that five-minute check is skipped and
  the next one catches up from the same cursor.

## Layout

- `prompt/AGENTS.md` — the base prompt, unchanged, plus Meetly's section.
- `skills/meetly-setup`, `skills/meetly-poll`, `skills/meetly-group` — what
  the agent does in setup, in the scheduled check and in a meeting group.
- `skills/meetly/scripts/` — the TypeScript CLIs behind them.
- `tests/` — `node --test` suites; `tests/fixtures/base-AGENTS.md` pins the
  base prompt to catch drift.
- `index/logo.png` — the Agent Index logo (uploaded to the listing, not
  served from here).
- `checks/` — `manual-scenarios.md` (end-to-end checklist) and `spike.md`
  (findings from the base code and the owner's Mac).
- `Dockerfile`, `compose.yml`, `dev/Caddyfile` — the image and local stack;
  `compose.arm64.yml` and `dev/build-base.sh` for Apple Silicon.

## Development

Tests need no Plow credentials, no Mac and no network.

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

Node 24.16 or newer. The OpenClaw runtime (`2026.9.6`) comes from the base
image, pinned by digest.

### Bumping the base image

Pick a newer `base-<sha>` tag and its digest from the
[gallery](https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents) and update the
`FROM` line in `Dockerfile`. Then:

1. Copy that commit's `prompt/AGENTS.md` over `tests/fixtures/base-AGENTS.md`,
   and update `REV`/`TAG` in `dev/build-base.sh` and the tag in
   `compose.arm64.yml`.
2. Re-apply the `## Meetly` section at the end of `prompt/AGENTS.md`.
3. Re-check `compose.yml` and `dev/Caddyfile` against the base.
4. Re-read the base's `plugin/index.ts` for `plow_start_thread`:
   `start-thread.ts` mirrors its `POST /v1/chats`.
5. Run `npm test`.
