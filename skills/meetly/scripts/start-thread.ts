// Starts a Plow group with the owner and the given phones: every group Meetly
// opens, in the poll and for the owner. It makes the same POST /v1/chats as
// the base's plow_start_thread tool (the owner's handle plus the phones,
// trusted, with an idempotency key), which refuses in the poll ("Starting a
// thread requires an active message") and gives Plow only 10 s: a slower
// Plow there reads as an unknown delivery that withholds the rest of the turn.
//
// A server error or a lost connection may still have created the group, so
// it reports { chatUid: null, deliveryUnknown: true } rather than failing:
// the caller records the request without a chat uid and never resends.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { isBlocked, loadBlocked } from "./blocklist.ts";
import { fetchIdentity, findOwnerDm, plowApi, type ApiOptions } from "./owner-chat.ts";
import { loadConfig } from "./config.ts";
import { assertDeliverable, awaitingOwnerApproval, sameHandle, updateRequest, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { isHandle } from "./reachable-handle.ts";
import { readJson, withLock, writeJson } from "./store.ts";

export type Started = { chatUid: string; messageSent: true } | { chatUid: null; deliveryUnknown: true };

export async function startThread(opts: ApiOptions & { members: string[]; body: string; requestId: string }): Promise<Started> {
  if (opts.members.length === 0) throw new Error("give at least one phone number");
  // A phone in E.164 or an iMessage email: reachable-handle.ts says which one.
  for (const m of opts.members) {
    if (!isHandle(m)) throw new Error(`not a phone in E.164 (like +15551234567) or an email: ${m}`);
  }
  // Fast check before remote identity reads; the authoritative check runs again
  // immediately before the POST to close the blocklist-update race.
  const blockedInitially = loadBlocked();
  for (const m of opts.members) if (isBlocked(blockedInitially, m)) {
    throw new Error(`do not contact: ${m} is on the owner's do-not-contact list; the owner must take them off it first`);
  }
  // The group is opened for one saved, open request, and only for its person; a
  // request still waiting for the owner never reaches them. A request that has a
  // chat already has its group: its times go there, and only a request saved
  // without one (and so gated) can open a new group.
  const request = readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find((r) => r.id === opts.requestId);
  if (!request || request.status !== "offered") throw new Error(`request ${opts.requestId} is not an open request: save the offer first`);
  const gateOn = loadConfig().ownerGate === true;
  // With the gate on, only the owner's yes opens a group: a request with no marker (saved before markers existed) waits too.
  if (awaitingOwnerApproval(request) || (gateOn && request.ownerApprovedAt === undefined)) {
    throw new Error(`request ${request.id} is waiting for the owner's approval: nothing may be sent yet`);
  }
  if (request.chatUid !== undefined) throw new Error(`request ${request.id} already has a group (${request.chatUid}): post its times there`);
  if (!opts.members.every((m) => sameHandle(m, request.handle))) throw new Error(`the member must be the request's person (${request.handle})`);
  if (!opts.body.trim()) throw new Error("the body is empty");
  const api = plowApi(opts);
  const identity = await fetchIdentity(api);
  const lineUid = identity.line?.uid;
  if (!lineUid) throw new Error("/v1/agents/me has no line uid");
  const dm = findOwnerDm(identity);
  if (!dm) throw new Error("the owner has not texted this line yet");
  const owner = dm.participants?.find((p) => p.type === "member" && p.role === "owner");
  if (!owner?.provider_key) throw new Error("the owner's chat has no owner handle");
  const members = [...new Set([owner.provider_key, ...opts.members])].sort();
  // The last blocklist check and the POST share the blocklist lock, so a block
  // that completes after this check waits until the opener is out.
  return withLock(file("blocked.json"), async (): Promise<Started> => {
    const blockedBeforePost = loadBlocked();
    for (const m of opts.members) if (isBlocked(blockedBeforePost, m)) {
      throw new Error(`do not contact: ${m} is on the owner's do-not-contact list; the owner must take them off it first`);
    }
    // The request identity must survive regenerated wording after an unknown
    // delivery; the opener body is not durable state in the ledger.
    const idempotencyKey = createHash("sha256").update(JSON.stringify([lineUid, `request:${request.id}`, members])).digest("hex");
    // The ledger lock is held from the last check through the POST and the link of the group, so a concurrent
    // replacement, approval change or expiry cannot slip in between: the request that was validated is the one
    // that is sent and linked.
    return withLock(file("ledger.json"), async (): Promise<Started> => {
      const ledger = readJson<Ledger>(file("ledger.json"), { requests: [] });
      assertDeliverable(ledger, request.id, { handle: request.handle, offeredAt: request.offeredAt, ownerApprovedAt: request.ownerApprovedAt }, gateOn);

      let res: Response;
      try {
        res = await api.fetch(`${api.base}/v1/chats`, {
          method: "POST",
          headers: { ...api.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ line_uid: lineUid, members, body: opts.body, trusted: true, idempotency_key: idempotencyKey }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return { chatUid: null, deliveryUnknown: true };
      }
      // Same rule as the plugin: 408, 424 and 5xx may have gone through.
      if ([408, 424].includes(res.status) || res.status >= 500) return { chatUid: null, deliveryUnknown: true };
      if (!res.ok) throw new Error(`POST /v1/chats returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      // The opener has gone out. A failure to read the answer or to link the group from here on is not a failed
      // delivery: report it as unknown, so the caller keeps the holds and the request and never runs the failure cleanup.
      try {
        const chat = (await res.json()) as { uid?: string };
        if (!chat.uid) return { chatUid: null, deliveryUnknown: true };
        // Link the group in the same write, before the ledger lock is released: no replacement or expiry can slip in between.
        writeJson(file("ledger.json"), updateRequest(ledger, request.id, { chatUid: chat.uid }, Date.now()));
        return { chatUid: chat.uid, messageSent: true };
      } catch {
        return { chatUid: null, deliveryUnknown: true };
      }
    });
  });
}

if (isMain(import.meta.url)) {
  run(() => {
    // Members and body come from the conversation, so they never go on the command line.
    const { values } = parseArgs({ options: { "input-file": { type: "string" } } });
    if (!values["input-file"]) throw new Error('pass --input-file F (JSON {"members":[…],"body":"…","requestId":"<the saved request id>"})');
    const input = JSON.parse(readFileSync(values["input-file"], "utf8")) as { members?: string[]; body?: string; requestId?: string };
    if (!input.requestId) throw new Error("the input needs requestId (the saved request id)");
    if (input.body === undefined) throw new Error("the input needs a body");
    return startThread({ members: input.members ?? [], body: input.body, requestId: input.requestId });
  });
}
