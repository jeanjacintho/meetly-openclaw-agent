// Replays cases.json against a captured image: each case swaps its message
// into the captured request for its chat kind, sends it to a model, answers
// every tool call from fixtures, and checks what the agent did.
//   node evals/replay/run.mjs --image meetly:dev [--model z-ai/glm-5.2] [--reps 3] [--only a,b]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: {
  image: { type: "string" }, capture: { type: "string" }, recapture: { type: "boolean" },
  model: { type: "string" }, endpoint: { type: "string", default: "https://openrouter.ai/api/v1" },
  "api-key-env": { type: "string", default: "OPENROUTER_API_KEY" },
  reps: { type: "string", default: "1" }, "max-steps": { type: "string", default: "30" }, only: { type: "string" }, conc: { type: "string", default: "6" },
  label: { type: "string" }, cases: { type: "string", default: join(import.meta.dirname, "cases.json") },
} });
const dir = opt.capture ?? join(import.meta.dirname, "captures", (opt.image ?? "").replace(/[^\w.-]+/g, "-"));
if (!opt.capture && !opt.image) throw new Error("--image or --capture is required");
if (opt.image && (opt.recapture || !existsSync(join(dir, "capture.json")))) {
  execFileSync(process.execPath, [join(import.meta.dirname, "capture.mjs"), "--image", opt.image, "--out", dir, "--cases", opt.cases], { stdio: "inherit" });
}
const capture = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
const spec = JSON.parse(readFileSync(opt.cases, "utf8"));
const model = opt.model ?? capture.model;
const apiKey = process.env[opt["api-key-env"]];
if (!apiKey) throw new Error(`set ${opt["api-key-env"]} for ${opt.endpoint}`);

// The captured request with this case's message, prior turns and first-contact flag.
function request(c) {
  const captured = capture.kinds[c.kind];
  const probe = `${capture.marker} ${c.kind}`;
  const swap = text => {
    let out = text.replace(probe, c.message);
    if (c.firstContact !== undefined) out = out.replace(/(first_contact\\*":)(true|false)/g, `$1${c.firstContact}`);
    return out;
  };
  const rewrite = content => typeof content === "string" ? swap(content) : content.map(part => part.type === "text" ? { ...part, text: swap(part.text) } : part);
  const [system, ...turn] = captured.messages;
  const { messages: _, stream: __, stream_options: ___, ...params } = captured;
  // A prior turn written "@name" is spec.name, so cases can share an offer.
  const prior = (c.prior ?? []).map(m => typeof m === "string" ? spec[m.slice(1)] : m);
  return { ...params, model, messages: [system, ...prior, ...turn.map(m => ({ ...m, content: rewrite(m.content) }))] };
}

async function complete(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${opt.endpoint}/chat/completions`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(`model HTTP ${response.status}: ${JSON.stringify(json).slice(0, 200)}`);
      return json;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

// A tool result: the case's own fixtures first, then the shared ones; `read`
// serves the image's files copied out at capture.
function answer(c, name, args) {
  const text = JSON.stringify(args);
  const hit = [...(c.results ?? []), ...spec.fixtures].find(f => new RegExp(`^(?:${f.tool})$`).test(name) && (!f.match || new RegExp(f.match).test(text)));
  if (hit) return hit.result;
  const path = name === "read" ? args.path : /^(?:cat|head|sed) .*?(\/\S+\.md)/.exec(args.command ?? "")?.[1];
  if (path && existsSync(join(dir, "files", path))) return readFileSync(join(dir, "files", path), "utf8");
  return { error: `no replay fixture for ${name} ${text.slice(0, 120)}` };
}

const SENDERS = ["message", "plow_reply_to"];
async function run(c, rep) {
  const body = request(c);
  const entry = { name: c.name, rep, calls: [], said: [], unanswered: [] };
  let silenced = false;
  for (let step = 0; step < +opt["max-steps"]; step++) {
    const message = (await complete(body)).choices[0].message;
    body.messages.push({ role: "assistant", content: message.content ?? "", ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
    if (!message.tool_calls?.length) {
      // As the plow channel does: no final reply after a tool result marked
      // silent, or after the message tool already answered in this chat.
      const final = message.content?.trim();
      if (final && final !== "NO_REPLY" && !silenced && !entry.calls.some(k => k.name === "message")) entry.said.push(final);
      break;
    }
    for (const call of message.tool_calls) {
      let args;
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = { unparsed: call.function.arguments }; }
      entry.calls.push({ name: call.function.name, args });
      if (SENDERS.includes(call.function.name)) entry.said.push(args.message ?? args.text);
      const result = answer(c, call.function.name, args);
      if (result?.error?.startsWith?.("no replay fixture")) entry.unanswered.push(result.error);
      if (result?.silent === true) silenced = true;
      body.messages.push({ role: "tool", tool_call_id: call.id, content: typeof result === "string" ? result : JSON.stringify(result) });
    }
  }
  entry.failures = grade(c, entry);
  return entry;
}

// Each expectation names one thing a good turn does or never does.
function grade(c, e) {
  const said = e.said.join("\n");
  const calls = (tool, match) => e.calls.filter(k => new RegExp(`^(?:${tool})$`).test(k.name) && (!match || new RegExp(match, "i").test(JSON.stringify(k.args))));
  const failures = [];
  for (const x of c.expect) {
    const n = x.call ? calls(x.call, x.match).length : 0;
    const ok = x.call ? n >= (x.min ?? 1) && n <= (x.max ?? Infinity)
      : x.noCall ? !calls(x.noCall, x.match).length
      : x.says ? new RegExp(x.says, "i").test(said)
      : x.neverSays ? !new RegExp(x.neverSays, "i").test(said)
      : x.silent ? !said.trim() : false;
    if (!ok) failures.push(x.why ?? JSON.stringify(x));
  }
  const sends = e.calls.filter(k => SENDERS.includes(k.name)).map(k => JSON.stringify(k.args));
  if (new Set(sends).size < sends.length) failures.push("sent the same message twice");
  return failures;
}

const offered = new Set(capture.kinds.owner_dm.tools.concat(capture.kinds.guest_group.tools).map(t => t.function.name));
const chosen = spec.cases.filter(c => !opt.only || opt.only.split(",").includes(c.name));
const skipped = chosen.filter(c => (c.requires ?? []).some(t => !offered.has(t)));
const jobs = chosen.filter(c => !skipped.includes(c)).flatMap(c => Array.from({ length: +opt.reps }, (_, i) => [c, i]));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: +opt.conc }, async () => {
  while (next < jobs.length) {
    const [c, rep] = jobs[next++];
    const entry = await run(c, rep).catch(error => ({ name: c.name, rep, calls: [], said: [], unanswered: [], failures: [`harness: ${error.message}`] }));
    results.push(entry);
    console.log(`${entry.failures.length ? "FAIL" : "pass"} ${c.name}#${rep}${entry.failures.length ? "  " + entry.failures.join(" | ") : ""}`);
  }
}));

console.log(`\n${capture.image} (captured ${capture.capturedAt.slice(0, 10)}) · model ${model}`);
for (const c of chosen) {
  const mine = results.filter(r => r.name === c.name);
  console.log(`  ${c.name.padEnd(24)} ${skipped.includes(c) ? `skipped: image lacks ${c.requires.filter(t => !offered.has(t)).join(", ")}` : `${mine.filter(r => !r.failures.length).length}/${mine.length}`}`);
}
const passed = results.filter(r => !r.failures.length).length;
console.log(`  ${"total".padEnd(24)} ${passed}/${results.length}`);
const label = opt.label ?? `${capture.image}-${model}`.replace(/[^\w.-]+/g, "-");
mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
writeFileSync(join(import.meta.dirname, "results", `${label}.json`), JSON.stringify({ image: capture.image, model, results }, null, 1));
console.log(`  details: evals/replay/results/${label}.json`);
if (passed < results.length) process.exitCode = 1;
