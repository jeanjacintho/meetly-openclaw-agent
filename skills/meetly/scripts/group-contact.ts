// Resolve the sole contact in an existing owner group from Plow's roster,
// never from a name or phone number claimed in message text.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { fetchIdentity, plowApi, type ApiOptions, type Identity } from "./owner-chat.ts";
import { isHandle } from "./reachable-handle.ts";

type Contact = { handle: string; name: string | null };

export function findGroupContact(identity: Identity, chatUid: string): Contact | null {
  const line = identity.line?.uid;
  if (!line) return null;
  const chats = (identity.chats ?? []).filter((chat) => chat.uid === chatUid && chat.status === "active");
  if (chats.length !== 1) return null;
  const ps = chats[0]!.participants ?? [];
  const self = ps.filter((p) => p.type === "agent" && p.relationship === "self" && p.line?.uid === line);
  const owners = ps.filter((p) => p.type === "member" && p.role === "owner");
  const contacts = ps.filter((p) => p.type === "member" && p.role !== "owner");
  if (ps.length !== 3 || self.length !== 1 || owners.length !== 1 || contacts.length !== 1) return null;
  const contact = contacts[0]!;
  if (!contact.provider_key || !isHandle(contact.provider_key)) return null;
  return { handle: contact.provider_key, name: contact.display_name?.trim() || null };
}

export async function groupContact(chatUid: string, opts: ApiOptions = {}): Promise<{ contact: Contact | null }> {
  return { contact: findGroupContact(await fetchIdentity(plowApi(opts)), chatUid) };
}

if (isMain(import.meta.url)) run(() => {
  const { values } = parseArgs({ options: { chat: { type: "string" } } });
  if (!values.chat) throw new Error("usage: group-contact.ts --chat <chat uid>");
  return groupContact(values.chat);
});
