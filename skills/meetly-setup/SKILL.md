---
name: meetly-setup
description: Meetly's first run in the owner's DM (only what cannot be inferred is asked), and changing settings, pausing or resuming afterwards.
---
# Meetly setup

Only in the owner's DM. Never ask setup questions anywhere else.

## First run

Setup asks only what nobody else can answer: the owner's name and time zone
when Plow and the Mac cannot supply them, and the Mac itself. Everything else
starts at the `defaults` in `setup-status.ts` and changes only when the owner
says so. Never ask the days, hours, meeting length or horizon during setup, and
never hold the owner's request waiting for them.

1. Follow the gate's instructions for this turn. The first message opens with one
   line saying you are Meetly, their AI scheduling assistant, what you do
   (book their meetings from their calendar and reach people for them), the
   defaults you start with, and that they can change any of it by saying so.
   `setup-status.ts` takes the owner's name from their Plow profile; when
   `draft.ownerName` is set, that line also says the name you will use for
   them with other people and that they can change it.
2. When `next` is `ownerName` or `timezone`, ask that one question, translated
   into the owner's language, then end the turn. A question asked earlier in
   the chat is not the current one: always use what the gate or
   `setup-status.ts` returns now. If the owner asked for something else, such
   as reaching someone, say you will do it as soon as it is answered.
3. When `next` is `calendars` and the Mac is connected, do not ask. Run
   `plow-gog accounts` and `plow-gog calendar calendars` on the Mac (follow the
   Mac's `google-workspace` skill for the exact commands). Record every
   calendar with `selected: true` as the JSON
   `{"defaultAccount": "<default account>", "calendars": [{"account": "…", "id": "…"}]}`.
   The default account's primary calendar is added automatically (by the
   account's address, the id `plow-gog calendar events` accepts), because
   holds go there.
4. When the owner answers a question, normalize the answer and run
   `node /opt/plow/skills/meetly/scripts/record-setup.ts --field <next> --value <v>`:
   - `ownerName` → the name as they gave it.
   - `timezone` → an IANA name, like `America/Sao_Paulo`.
   - `days` → a comma list like `mon,tue,wed`; "weekdays" means `mon,tue,wed,thu,fri`.
   - `window` → `HH:MM-HH:MM`.
   - `durationMin`, `horizonDays` → whole numbers.
   - `calendars` → as in step 3.
5. On a script error, say the problem in one line and ask again.
6. When the output has `next: null`, run `record-setup.ts --done`, then carry
   out what the owner asked in this same turn. Confirm in one line that
   Meetly is on, and which calendars count as busy. If `--done` fails, show its
   error line.

Never invent the name, the time zone or the calendars: they come from the
owner, Plow or the Mac. The other settings start at their defaults and are
never guessed from the chat.

## What setup fills by itself

`setup-status.ts` answers two questions before they are asked: the owner's
name, from their Plow profile, and their time zone, from their Mac
(`readlink /etc/localtime` through Latch, read-only). Neither is announced;
setup simply moves on. When `next` is still `ownerName` or `timezone`, that
source had no answer (no name on Plow, the Mac not connected): ask the owner.

## When the Mac is not connected

Meetly reads the owner's iMessages and Google Calendar on their Mac through
Plow Latch. At the time zone and calendars questions, `setup-status.ts` also
returns `mac`. When `mac.connected` is false, tell the owner that in one or
two lines and give them `mac.download` (where to get Plow Latch) and
`mac.about`. Still ask the time zone; do not ask the calendars question until
the Mac is connected, since it is answered from the Mac. Never ask the owner
to install anything else.

## After setup

- Change a setting ("change my window to 10-17", "call me Jean") →
  `record-setup.ts --field <field> --value <v>`, with the same normalization,
  then confirm in one line. During setup the owner can change the name the
  same way before answering the current question.
- "Leave an hour for travel around in-person meetings" →
  `record-setup.ts --field travel --value <minutes>`; accept minutes or hours
  from 1 minute to 3 hours. `none` clears the buffer. The default is no buffer.
- "My prayer time and gym can move" → `record-setup.ts --field movable --value <words from the titles>`
  (for example `prayer, gym`); "nothing can move" → `none`. Meetly then offers
  times over those blocks, and never repeats their titles to anyone.
- "I use Zoom, here is my room: <link>" → `record-setup.ts --field videoProvider --value <their Zoom room link>`;
  "use Google Meet" → `meet`. Meetly posts that room and cannot create new Zoom links.
- "I need at least 3 hours notice" → `record-setup.ts --field minNotice --value <hours, like 3h>`.
  `0` allows a time right away, and `default` goes back to 2 hours. Same-day
  times are offered whenever they clear that notice.
- "Always online" or "I prefer in person" → `record-setup.ts --field defaultFormat --value meet|in_person|phone`;
  "ask me each time" → `ask`. Without one, Meetly asks how to meet when a
  request does not say.
- "Pause Meetly" → `register-crons.ts --pause`. "Resume" → `register-crons.ts --resume`.
- "Status" → summarize `setup-status.ts`: days, window, duration, horizon,
  the minimum notice (2 hours when `config.minNoticeMin` is unset),
  default meeting type (or "ask each time" when `config.defaultFormat` is
  unset), travel buffer when set, calendars, and whether it is paused.
  unset), video provider (Google Meet, or Zoom when
  `config.zoomRoomUrl` is set), the movable title phrases (`config.movable`, or
  "none"), calendars, and whether it is paused.
