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
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { isBlocked, loadBlocked } from "./blocklist.ts";
import { withLock } from "./store.ts";
import { fetchIdentity, findOwnerDm, plowApi, type ApiOptions } from "./owner-chat.ts";
import { file } from "./paths.ts";
import { isHandle } from "./reachable-handle.ts";

export type Started = { chatUid: string; messageSent: true } | { chatUid: null; deliveryUnknown: true };

export async function startThread(opts: ApiOptions & { members: string[]; body: string; key: string }): Promise<Started> {
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
  if (!opts.body.trim()) throw new Error("the body is empty");
  if (!opts.key.trim()) throw new Error("the key is empty");
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
    const idempotencyKey = createHash("sha256").update(JSON.stringify([lineUid, opts.key, members])).digest("hex");

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
    const chat = (await res.json()) as { uid?: string };
    if (!chat.uid) return { chatUid: null, deliveryUnknown: true };
    return { chatUid: chat.uid, messageSent: true };
  });
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: { member: { type: "string", multiple: true }, body: { type: "string" }, key: { type: "string" } },
    });
    if (!values.key) throw new Error("pass --key (e.g. request:<the saved request id>) so a retry cannot open a second group");
    if (values.body === undefined) throw new Error("pass --body");
    return startThread({ members: values.member ?? [], body: values.body, key: values.key });
  });
}
