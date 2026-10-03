---
name: meetly-poll
description: The scheduled Meetly poll. Read the owner's new iMessages, open groups for people who want to meet, and expire stale holds.
---
# Meetly poll

This turn is unattended and has no inbound Plow message. Do the work, send only
the messages listed here, then end. Scripts are
`node /opt/plow/skills/meetly/scripts/<name>.ts`. Mac commands go through
Latch's `plow_run_command` (the tool name may be server-prefixed). Follow the
Mac's own `plow-messages`, `contacts` and `google-workspace` skills for their
exact argument arrays, and always pass `read_paths: ["~/Library/Messages"]`
to `plow-messages`.

This unattended turn has no current conversation. Send meeting notifications
with `message` (action `send`, channel `plow`, accountId `chat`, target the
meeting's `chatUid`); the owner is in that thread. For an operational warning
with no meeting thread, use `owner-chat.ts` and target the printed `chatUid`.
Before each contact-visible poll message, immediately check
`blocklist.ts check --handles-file <file>` (a JSON array with the handle, written to
`/var/lib/plow/meetly/tmp/handles-<request id or sender rowid>.json`; never a
shared name, and never on the command line). If blocked, skip it and do
not update the reminder or nudge timestamp; private owner notifications may
still explain why no contact message was sent.

1. Run `setup-status.ts`. If it is not `READY`, or `config.paused` is true, end.
   (Pausing disables this job, so a paused Meetly sends no reminders either.)
   **Reminders** come first, before any messages are read, so a slow batch
   never delays a link:
   1. Run `ledger.ts reminders`. None: go to step 2.
   2. For each request, read its event:
      `plow-gog calendar event primary <eventId> --account <booked.account> --json`.
      Save the whole output with the `write` tool to
      `/var/lib/plow/meetly/tmp/reminder-<id>.json`. If the read fails, skip
      this request: the next poll tries again while the window lasts.
   3. Run `reminder-check.ts --id <id> --event-file <that file>`. It
      compares the event with the ledger, saves any change, and prints
      `action`:
      - `send`: send one message to `send.chatUid` (when it is `null`, to
        the owner's DM instead). Write it in `send.locale`, third person,
        using `send.name` and `ownerName`: the meeting starts in
        `send.minutesToStart` minutes (at `send.time`), with `send.meetUrl`.
        Use that URL exactly as printed; never any other link. Then run
        `reminder-check.ts --id <id> --sent`. If delivery is unknown, still
        mark it sent: never resend.
      - `wait`: the meeting moved; nothing now.
      - `cancelled`: the event was deleted (a Meet or an in-person meeting
        with travel buffers); send nothing.
      - `no-link`: the Meet was removed from the event. Tell the meeting
        thread in one line that no link went out for <name>'s meeting.
      - `skip`: already handled, or not a Meet: nothing to send.
2. Run `cursor.ts get`. If `rowid` is `null`: run `plow-messages search
   --order desc --limit 1`, then `cursor.ts set <that rowid, or 0>`, and end.
   Never scan history.
3. Run `plow-messages search --after-rowid <rowid> --order asc --limit 50`.
   - On failure, or a `blocked` result: run `cursor.ts fail`. If `warn` is
     true, send the owner one DM saying Meetly can't read their messages;
     if the Mac gave an `owner_action`, include it word for word. If the Mac
     is not connected at all, say Meetly needs Plow Latch on their Mac and
     give https://plow.co/download/latch. End.
   - Empty: run `cursor.ts ok` and go to step 6.
4. Keep inbound rows (`is_from_me` false) from direct chats only. Group them by
   `sender`, in rowid order. For each sender:
   1. Run `plow-messages thread --handle <sender> --limit 20` for context.
   2. Decide whether they want to meet, call or schedule something with the
      owner. These are not requests: short codes, verification codes,
      marketing, automated senders, mentions of something already booked,
      and anything unclear.
   3. If the owner replied after the request, skip: the owner is handling it.
   4. If `ledger.ts find --handles-file <file with the sender>` has an open request, skip,
      except one waiting for owner approval (listed by `ledger.ts approvals`)
      whose `sourceRowid` `cursor.ts` still has held: the previous run died before the
      owner's ask was delivered, so send that saved ask again (`meetly-group` owner
      gate, from the saved offer) and run `cursor.ts set` only after that DM
      succeeded. If
      `blocklist.ts check --handles-file <file with the sender>` says `blocked`, skip.
   5. Run `cursor.ts hold <the request's rowid>` (the same rowid you pass as
      `sourceRowid`) before anything else. Until the ledger records a request
      with that `sourceRowid`, `cursor.ts set` stops just below it, so a run
      that fails part-way retries it.
      If you decide after all that it is not a request, run `cursor.ts
      release`.
   6. Follow `meetly-group` "Offer times" with `origin: inbound`,
      `sourceRowid` = the request's rowid, the topic, any times they
      proposed, the format if their words say it (`meetly-group` "Meeting
      format", which also applies the owner's default), and their `locale`.
      `meetly-group` alone decides whether to ask the owner first or open the
      group; the poll never opens one itself.
   7. If that fails before the group started, stop processing senders. Run
      `cursor.ts set <the rowid just below this sender's first row in the
      batch>` and go to step 6.
5. Run `cursor.ts set <highest rowid in the batch>`.
6. Maintenance:
   - Run `ledger.ts expire`: in one locked write it closes every request whose
     holds ran out, queues their holds for the cleanup step
     below, and returns those requests as they were. For each one returned:
     If it has a `chatUid`, check the blocklist then tell the group the held
     times were released; this also notifies the owner. If `ownerApprovalAt`
     was set, `ownerApprovedAt` is absent and there is no `chatUid`, tell the
     owner in their DM that approval expired and the holds were released. If
     `ownerApprovedAt` is set but there is no `chatUid`, tell the owner the
     delivery is unknown, the holds expired and they must check Messages; do
     not resend. Never contact the other person before approval.
   - Run `ledger.ts monitor`: it lists what waits on the owner, Meetly or the
     other person too long. For each `waitingOnThem` item, read the latest
     messages in that meeting thread first. If the person has already
     answered, do not nudge; handle their reply in the group. Otherwise send
     one brief, friendly follow-up in their language, asking whether any held
     time works or whether Meetly should find other times. Do not imply that
     they forgot or that a time was booked. Then run `ledger.ts update --id
     <id> --json '{"personNudgedAt":"<now ISO>"}'` so this offer is nudged
     once. A replacement offer makes the next follow-up eligible after 24
     hours.
     For each `ownerWaiting` item with a `chatUid`, first run `blocklist.ts
     check --handles-file <file with item.handle>`; if blocked, skip it. Otherwise remind the
     owner in that meeting thread (`message`, that chat uid as its target), in
     one line and in their language, that the time they were asked about is
     still waiting for their yes or no, with its `nextStep`, then run
     `ledger.ts update --id <id> --json '{"nudgedAt":"<now ISO>"}'` so it is
     sent once. For an `ownerWaiting` item with no `chatUid` (a gated inbound
     request that has no group yet), remind the owner in their DM instead
     (`owner-chat.ts`, then `message` to its `chatUid`): the contact is not
     messaged, so no blocklist check is needed; run the same `nudgedAt` update.
     For each
     `deliveryUnknown` item, tell the owner in their DM that Meetly cannot
     confirm whether the group offer arrived, ask them to check Messages
     manually, and explicitly say never to resend. Do not open another group
     or send another offer. After the warning run `ledger.ts update --id <id>
     --json '{"nudgedAt":"<now ISO>"}'` so it is sent once.
   - For each request from `ledger.ts cleanup`: retry each delete, and after
     each successful one write `{ "holdId": "...", "account": "..." }` to a
     JSON file and run `ledger.ts cleanup-remove --id <id> --json-file <file>`.
     Never replace the whole `holdCleanup` list: a promotion or discard may
     have queued more holds since `cleanup` read it.
7. If nothing happened, end silently.
