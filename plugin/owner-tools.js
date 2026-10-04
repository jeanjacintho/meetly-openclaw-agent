// The owner's decisions that let Meetly reach someone: approving a request and
// switching approval off. They are plugin tools, not scripts, because a tool
// is handed the turn by the runtime (session, channel, whether the sender is
// the owner), and the model cannot write that. A script only sees what the
// model passed it, so a poll turn reading a guest's text could claim to be the
// owner; here it is refused.
export const SCRIPTS = "/opt/plow/skills/meetly/scripts";

/** The owner's main Plow DM, as the runtime reports the turn: the same test the base's plugin applies. */
export function isOwnerDm(context) {
  return context?.sessionKey === "agent:main:main" && context.messageChannel === "plow"
    && context.agentAccountId === "chat" && context.senderIsOwner === true;
}

const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const NOT_OWNER = "Only the owner can do this, in their own DM with Meetly. Nothing was changed: tell the owner it waits for their answer there.";

const definitions = [
  {
    name: "meetly_approve_request",
    description: "Approve a request that waits for the owner (ledger.ts approvals lists them), so its group can be opened with start-thread.ts. Use it only in the owner's own DM: when the owner says yes to a pending request, or right after saving a request the owner just asked for. Returns approved: false when the request was already closed or approved.",
    parameters: object({ id: { type: "string", description: "The request id, r_…" } }, ["id"]),
    run: async (load, args) => (await load("ledger.ts")).approve(args.id),
  },
  {
    name: "meetly_set_owner_gate",
    description: "Turn on or off whether Meetly asks the owner before reaching someone it found in their messages. Use it only in the owner's own DM, when the owner asks for that change.",
    parameters: object({ on: { type: "boolean", description: "true: ask the owner first (the default); false: reach out without asking" } }, ["on"]),
    run: async (load, args) => (await load("record-setup.ts")).record("ownerGate", args.on ? "on" : "off", { ownerTurn: true }),
  },
];

export const OWNER_TOOLS = definitions.map((d) => d.name);

const importScript = (name) => import(`${SCRIPTS}/${name}`);

export function registerOwnerTools(api, load = importScript) {
  for (const { name, description, parameters, run } of definitions) {
    api.registerTool((context) => ({
      name, label: name, description, parameters,
      async execute(_id, args) {
        let result;
        try {
          result = isOwnerDm(context) ? await run(load, args ?? {}) : { error: NOT_OWNER };
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }), { name });
  }
}
