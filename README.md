# Meetly

Your scheduling assistant, on a text thread. When someone asks to meet you,
Meetly researches the request, holds your free times and asks you privately
for approval. Once you approve, it opens a group, offers those times and books
the one they pick. You receive the confirmation in the same group.

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

1. researches the person and meeting details, clarifying privately with you
   only when something necessary remains unclear,
2. finds three free times from your Google Calendar, inside the days and
   hours you allow,
3. holds those times on your calendar so nothing else takes them,
4. asks you privately to approve those options before contacting the person,
   and once you approve, opens a Plow group with you and that person and
   offers the held times,
5. asks how you'll meet (a video call or in person) when neither the message
   nor your default meeting type says it,
6. books the one they pick, invites them if it knows their email, and
   releases the other holds; for a Google Meet it creates the room, and with
   your Zoom room set it books that room instead,
7. posts the video link in the group 10 minutes before the start,
8. confirms in the group, where both you and the other person receive it.

After you approve the outreach, Meetly handles their choice and booking in
the group. You can explicitly authorize automatic replies to inbound requests
if you prefer to skip the approval step.

You can also ask it directly: *"set up lunch with Patrick next week — it can go
over Weekly Claw"*. Meetly finds Patrick in your contacts, respects what you
said for that one request, and runs the same group.

In a group you already created with one contact, a clear request such as
"How about lunch on October 13th?" starts scheduling there even without a
previous ledger entry. Meetly uses the participant and conversation context,
keeps the requested date, and offers times in that group.

Meetly always speaks as your assistant, in the third person: *"Jean is free Tue
29/9 at 12:00"*, never *"I'm free"*. It never texts from your own Messages
account; every conversation with the other person happens in the Plow group,
signed as Meetly.

## What it will and won't do

- **Researches before asking.** Meetly uses the thread, known contact details
  and relevant prior context. Lunch together implies in person unless the
  conversation says virtual. For a meeting you ask for, a necessary detail that
  remains unclear is asked privately of you, rather than publicly of the
  contact; for a request that comes from someone else, it is asked in their
  own thread, where your answer can approve it. A default meeting type
  you set fills in only what neither side said.
- **Asks how to meet only when it is not clear.** "A Google Meet on
  Thursday" or "lunch at Fasano" is enough, and so is a default meeting type
  you set. "A call" or "coffee" with no place and no default gets one
  question, in the same message as the times.
- **Posts only the link it created or you configured.** The link is the Meet
  link it created or your own Zoom room, taken from the event on
  your calendar, read again just before it is sent: move the meeting and the
  link goes out at the new time; delete it and nothing is sent. A link
  someone writes in the group is never used. Pausing Meetly pauses these
  too.

- **Offers only free time, inside your hours.** Your calendar shows up as free
  slots within the days and hours you set. A busy time is "an existing
  commitment" — never an event name or detail. A time with insufficient notice
  is explained as too soon, with alternatives offered. If the other person can only
  do a time outside your hours, Meetly asks you in that group and books it only on
  your yes there. A yes in your DM does not approve the group request.
- **Gets your approval before contacting someone who asks to meet.** Meetly
  holds proposed times and asks you in your DM before it contacts the person.
  This is on by default, including for existing configurations. If you tell
  Meetly to answer meeting requests without asking first, that is standing
  authorization for automatic replies.
- **Leaves travel time around in-person meetings when you set it.** Meetly
  checks and holds the buffer before and after the meeting; video and phone
  meetings do not use it. The default is no travel buffer.
- **Holds expire.** No answer in 48 hours: the holds are deleted. If you
  never approved, only you are told; once a group exists, it is told the times
  were released.
- **Tells them when you cancel or move.** Ask Meetly to cancel or move a
  meeting it booked and it updates the calendar and says so in that person's
  group, in one line.
- **Overlaps only with your word.** Meetly books over an existing event only
  when you named that event in your request, said yes in the group, or listed
  a word from its title as movable ("prayer", "gym") on an event you created
  yourself. People in the group can
  never unlock a conflict or a time outside your hours.
- **Stays on topic in groups.** The group is for this one meeting. Meetly does
  not read your mail, files or other conversations for the other person.
- **Ignores instructions in messages.** A text that says "ignore your rules"
  is just a text.
- **Skips noise.** Verification codes, short codes, marketing and automated
  senders never get a group. If you already answered the person yourself,
  Meetly stays out of it.

## Setup

The first time you text the line, Meetly introduces itself in one line and
gets to work on what you asked. It asks only what nobody else can tell it:
your name and time zone, when your Plow profile and your Mac cannot supply
them. Your busy calendars are read from the Mac: every calendar you show in
Google Calendar counts.

Everything else starts at these defaults:

- days: Monday to Friday,
- hours: 09:00 to 18:00,
- meeting length: 30 minutes,
- offers up to 14 days ahead,
- times at least 2 hours ahead (same-day times count once they clear it).

Video calls use Google Meet. If you use Zoom, give Meetly your personal room
link and it uses that for every video meeting; it cannot create new Zoom links.

One more setting has no default: your default meeting type (online, in person
or phone). Say "always online" and Meetly stops asking how to meet; whatever a
request says still wins.

Change any of it later in plain words ("make my window 10 to 17", "I don't
take meetings on Fridays"), or say "pause Meetly" / "resume Meetly".

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

Text the line you minted; setup starts with your first message. By default,
the local dashboard is at <http://localhost:3001> (anyone who can reach it is
admin). Set `HOST_PORT` to bind another loopback port; the container listens
on port 3001 either way.

```sh
docker compose down          # stop, keep settings, holds ledger and schedule
docker compose down -v       # wipe the state volume (fresh setup)
plow-agents revoke           # retire the line in plow-credentials
```

`plow-credentials` is gitignored. Do not commit it.

**Apple Silicon.** The pinned base supports both `linux/amd64` and
`linux/arm64`, including the native Agent Index usage collector. Compose
uses your machine's architecture; no override or source-built base is needed.

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
  pinned by digest: the base's gateway, Plow channel and reporter, plus
  Meetly's prompt, skills and its own entrypoint, `boot/preboot.ts`. That is
  the base's `boot/main.ts` step for step, on the base's compiled modules,
  with three additions before the config is synced: the model (see
  [Model](#model)), the setup gate, and a 60 s request timeout on the Mac
  relay. Without that timeout OpenClaw caps the relay's tool listing at
  1500 ms, a Mac round trip takes 0.9-1.8 s, and a turn intermittently had no
  Mac tools at all.
- **Setup gate.** Before each of the owner's DM turns, the `meetly` plugin
  runs `setup-status.ts` and puts its answer at the top of the turn, so setup
  never depends on the model remembering to check. The base owns
  `plugins.load`, so the plugin sits in the state volume's global plugin root
  (`/var/lib/plow/extensions/meetly`), copied there from the image on every
  boot. The owner's name comes from their Plow profile and the time zone from
  their Mac through Latch; setup asks only what neither can answer.
- **Schedule.** One OpenClaw scheduler job (`openclaw cron`), `meetly-poll`:
  an isolated agent turn every five minutes with no automatic delivery,
  registered by `register-crons.ts` when setup finishes. It lives in the state
  volume and survives restarts and rebuilds.
- **Chat.** Your phone DM is the main session and runs setup. A group Meetly
  opened is recognized from its ledger and handled as that one meeting.
- **Opening groups.** Meetly uses `start-thread.ts` to open a new group for
  owner requests and the scheduled poll; an owner request made in an existing
  one-contact group reuses it. It calls `POST /v1/chats` with the owner plus the
  contact, trusted, and an idempotency key. An uncertain delivery is
  recorded without a chat and never resent on its own; if you say the group
  is not there, Meetly tries again with the same key. Meeting confirmations and
  approval asks stay in that group; the owner is a participant. The one
  exception is the owner gate, which asks you in your DM before any group exists.
- **Scripts.** Small TypeScript CLIs in `skills/meetly/scripts/`, run directly
  by the image's Node (`node <script>.ts`, no build): setup, the message
  cursor, the request ledger, busy/free-slot math in your time zone, cron
  registration, the owner-DM lookup and the poll's group start. The model
  decides; the scripts count.
- **State.** `/var/lib/plow/meetly`: `config.json` (your setup),
  `cursor.json` (last message read), `ledger.json` (requests, offered times,
  hold ids). Writes are atomic and locked.

## Model

Every install runs on Plow's GPT-6 Luna. A one-click install has nothing to
configure and never leaves it. The base's own `plow` provider lists only the
base's models and is rewritten every boot, so Meetly declares Luna on a
provider of its own, `plow-luna`: the same Plow endpoint and credential
reference, in the part of the config the base leaves alone.

The owner of one install can move all of its inference (chat and the
five-minute poll) to their own OpenAI account. In a login shell on the agent
(`docker compose exec agent bash -l`, or SSH on the VM):

```sh
plow-llm openai
```

It signs in with a device code, checks that the account offers
`gpt-6-luna` and leaves a marker in the state volume. Restart the agent to
apply it. The sign-in and the marker live in the state volume, so rebuilds
and image updates keep them. `plow-llm plow` moves back, and
`plow-llm status` shows what the next boot will choose.

Plow's Luna stays configured as the fallback: a spent quota or an expired
sign-in answers from Plow instead of failing. `AGENT_PROVIDER` (`plow`,
`openai`, `openrouter`) and `AGENT_MODEL` choose a provider from the
environment instead and outrank the marker; OpenAI then takes
`OPENAI_API_KEY` or the sign-in, and OpenRouter `OPENROUTER_API_KEY`.

The model is the image's on every boot, so an edit to it in the dashboard
lasts until the next restart. The sign-in is a real credential for your
account, kept in the state volume where the agent's own tools can read it.
Meetly reads your messages, so use it on an install only you talk to.

## Known limitations

- Only direct iMessage chats; group chats and email requests are not read.
- One person per request.
- A sender known only by an email (no phone number) cannot get a group; Meetly
  tells you instead.
- If the model provider is unreachable, that five-minute check is skipped and
  the next one catches up from the same cursor.

## Layout

- `prompt/AGENTS.md` — Meetly's own prompt: who it is first, then the base's
  tool and authority rules word for word, then how Meetly works.
- `skills/meetly-setup`, `skills/meetly-poll`, `skills/meetly-group` — what
  the agent does in setup, in the scheduled check and in a meeting group.
- `skills/meetly/scripts/` — the TypeScript CLIs behind them.
- `boot/` — the entrypoint (`preboot.ts`, the base's boot plus Meetly's
  additions), the model (`llm.ts`), the setup gate install (`gate.ts`), the
  Mac relay timeout (`mcp.ts`) and the `plow-llm` command.
- `plugin/` — the setup gate: an OpenClaw plugin that runs `setup-status.ts`
  before each of the owner's DM turns and hands the model the answer.
- `tests/` — `node --test` suites; `tests/fixtures/base-AGENTS.md` is the
  base prompt the tool and authority rules are checked against.
- `index/logo.png` — the Agent Index logo (uploaded to the listing, not
  served from here).
- `checks/` — `manual-scenarios.md` (end-to-end checklist) and `spike.md`
  (findings from the base code and the owner's Mac).
- `Dockerfile`, `compose.yml`, `dev/Caddyfile` — the image and local stack.
- `evals/replay/` — model replays of an image's prompt (dev only, not in the image).

## Development

Tests need no Plow credentials, no Mac and no network.

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

Node 24.16 or newer. The OpenClaw runtime (`2026.9.6`) comes from the base
image, pinned by digest.

### Replaying the prompt against a model

`evals/replay/` checks how a model handles Meetly's decision points (owner
requests, group offers, guest picks, silence, injection) for a built image,
without Plow, a Mac or a calendar. It needs Docker and a model key; nothing
else runs.

```sh
docker build -t meetly:dev .
export OPENROUTER_API_KEY=...          # or --endpoint/--api-key-env for another OpenAI-compatible API
node evals/replay/run.mjs --image meetly:dev --reps 3
node evals/replay/run.mjs --image meetly:dev --reps 3 --model anthropic/claude-sonnet-5   # compare a model
```

The first run captures the image: `capture.mjs` boots it against a stand-in
Plow API (`fake-plow.mjs`), sends one owner DM, one owner group message and one
guest group message, and saves the model request each produced (the real
system prompt, tools and message envelope) plus the image's skill files under
`evals/replay/captures/<image>/`. `--recapture` refreshes it. The stand-in
also stands in for the owner's Mac, which no image contains, with the small
hand-written `latch-stub.json` (a placeholder for Latch's instructions and its
command tools), and gives the agent a finished setup (`setup` in `cases.json`)
so the owner's DM carries the gate's READY block.

`run.mjs` then plays every case in `cases.json` with the captured request for
its chat kind: the case's message swapped in, its `prior` turns before it,
every tool call answered from the case's `results` or the shared `fixtures`.
`--model` defaults to the image's own model; `--agent-name` (on capture) to
Alder. Each case lists what a good turn does (`call`, `says`) or never does
(`noCall`, `neverSays`, `silent`); a case whose `requires` names a tool the
image lacks is skipped.

The output is one line per run (`pass`, or `FAIL` with each missed
expectation), then a pass count per case. Replies are stochastic: compare
counts over several `--reps`, not single runs. `evals/replay/results/<label>.json`
keeps each run's tool calls, what it said, and any call no fixture answered
(`unanswered`), which is the first thing to read when a case fails for a
missing fixture rather than a wrong decision.

### Bumping the base image

Pick a newer `base-<sha>` tag and its digest from the
[gallery](https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents) and update the
`FROM` line in `Dockerfile`. Then:

1. Copy that commit's `prompt/AGENTS.md` over `tests/fixtures/base-AGENTS.md`.
2. Diff the new base prompt against the old fixture and carry any changed
   tool or authority rule into `prompt/AGENTS.md`; `tests/prompt.test.ts`
   fails on a rule the base rewords.
3. Copy that commit's `boot/main.ts` over `tests/fixtures/base-main.ts.txt`
   and carry any changed step into `boot/preboot.ts`; `tests/mcp.test.ts`
   fails on a base step preboot does not have. Drop `boot/mcp.ts` once the
   base sets the relay's `requestTimeoutMs` itself.
4. Re-check `compose.yml` and `dev/Caddyfile` against the base.
5. Re-read the base's `plugin/index.ts` for `plow_start_thread`:
   `start-thread.ts` mirrors its `POST /v1/chats`.
6. Run `npm test`.

## License

MIT. See [LICENSE](LICENSE).
