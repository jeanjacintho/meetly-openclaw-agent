// Boots an agent image against the fake Plow API, sends one message of each
// kind (owner DM, owner in a group, guest in a group) and saves the model
// request each turn produced: the image's real system prompt, tools and
// message envelope, which run.mjs replays.
// The skills and workspace files are copied out beside it, so a replayed
// `read` of a skill gets the image's own text.
//   node evals/replay/capture.mjs --image meetly:dev [--out evals/replay/captures/meetly-dev]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { startFakePlow } from "./fake-plow.mjs";

const { values: opt } = parseArgs({ options: {
  image: { type: "string" }, out: { type: "string" },
  "agent-name": { type: "string", default: "Alder" }, keep: { type: "boolean" }, cases: { type: "string", default: join(import.meta.dirname, "cases.json") },
} });
if (!opt.image) throw new Error("--image is required");
const { world: worldSpec, setup } = JSON.parse(readFileSync(opt.cases, "utf8"));
const captureDir = (image) => join(import.meta.dirname, "captures", image.replace(/[^\w.-]+/g, "-"));
const out = opt.out ?? captureDir(opt.image);
const env = JSON.parse(execFileSync("docker", ["image", "inspect", opt.image]))[0].Config.Env;
// Plow creates groups trusted when the image asks for trusted groups.
const trusted = env.includes("PLOW_THREAD_TRUST=trusted");
const MARKER = "REPLAY_PROBE";

const world = { agentName: opt["agent-name"], chats: [
  { uid: "cht_owner", trusted: true, members: [worldSpec.owner] },
  { uid: "cht_owner_group", trusted, members: [worldSpec.owner, worldSpec.guest] },
  { uid: "cht_guest_group", trusted, members: [worldSpec.owner, worldSpec.guest] },
] };
const probes = [
  ["owner_dm", "cht_owner", worldSpec.owner.uid],
  ["owner_group", "cht_owner_group", worldSpec.owner.uid],
  ["guest_group", "cht_guest_group", worldSpec.guest.uid],
];

// A finished setup, so the owner's DM turn carries the setup gate's READY block.
const state = mkdtempSync(join(tmpdir(), "meetly-replay-"));
mkdirSync(join(state, "meetly"), { recursive: true });
writeFileSync(join(state, "meetly", "config.json"), JSON.stringify(setup.config));
execFileSync("chmod", ["-R", "a+rwX", state]);

const fake = await startFakePlow(world);
world.apiBase = `http://host.docker.internal:${fake.port}`;
const name = `meetly-replay-capture-${process.pid}`;
const until = async (what, test, seconds = 240) => {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(500)) if (test()) return;
  throw new Error(`timed out waiting for ${what}; see docker logs ${name}`);
};
try {
  execFileSync("docker", ["run", "-d", "--name", name, "--add-host", "host.docker.internal:host-gateway",
    "-e", `PLOW_API_BASE=${world.apiBase}`, "-e", "PLOW_AGENT_TOKEN=replay",
    "-v", `${state}:/var/lib/plow`, opt.image], { stdio: "ignore" });
  await until("the agent to connect", fake.connected);
  await sleep(3000);
  const kinds = {};
  for (const [kind, chat, sender] of probes) {
    const text = `${MARKER} ${kind}`;
    fake.send(chat, sender, text);
    const has = r => JSON.stringify(r.messages.filter(m => m.role === "user")).includes(text);
    await until(`the ${kind} model request`, () => fake.requests.some(has));
    kinds[kind] = fake.requests.find(has);
    console.log(`${kind}: system ${JSON.stringify(kinds[kind].messages.filter(m => m.role === "system")).length} chars, ${kinds[kind].tools?.length ?? 0} tools`);
  }
  const imageId = JSON.parse(execFileSync("docker", ["image", "inspect", opt.image]))[0].Id;
  for (const dir of ["/opt/plow/skills", "/var/lib/plow/workspace"]) {
    mkdirSync(join(out, "files", dir, ".."), { recursive: true });
    execFileSync("docker", ["cp", `${name}:${dir}`, join(out, "files", dir, "..")], { stdio: "ignore" });
  }
  writeFileSync(join(out, "capture.json"), JSON.stringify({ image: opt.image, imageId, capturedAt: new Date().toISOString(), marker: MARKER, model: kinds.owner_dm.model, kinds }, null, 1));
  console.log(`model ${kinds.owner_dm.model}; saved ${out}`);
} catch (error) {
  if (opt.keep) writeFileSync(`${out}.requests.json`, JSON.stringify(fake.requests, null, 1));
  throw error;
} finally {
  if (!opt.keep) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  await fake.close();
  rmSync(state, { recursive: true, force: true });
}
