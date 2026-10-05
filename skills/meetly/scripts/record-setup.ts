// Saves one setup answer (to the draft, or to config.json once set up), or
// finishes setup with --done and registers the cron jobs.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { isField, mergeDurations, nextField, parseField, QUESTIONS, validateConfig, type Config, type Field, type RequiredField } from "./config.ts";
import { file } from "./paths.ts";
import { readJson, removeFile, updateJson, withLock, writeJson } from "./store.ts";
import { gateOpenRequests, type Ledger } from "./ledger.ts";
import { registerFromConfig } from "./register-crons.ts";

export type Recorded =
  | { saved: Field; config: Config }
  | { saved: Field; next: RequiredField | null; question: string | null };

// `ownerTurn` is true only when the plugin's meetly_set_owner_gate calls this from the owner's own DM turn, as the
// runtime reports it. A script run never is: a turn driven by a guest's text must not switch the approval off.
export function record(field: string, value: string, { ownerTurn = false } = {}): Recorded {
  if (!isField(field)) throw new Error(`unknown field: ${field}`);
  const patch = parseField(field, value);
  if (patch.ownerGate === false && !ownerTurn) {
    throw new Error("only the owner can turn approval off, with the meetly_set_owner_gate tool in their own DM; no script can");
  }
  // One format's length is changed at a time; the others stay as they were.
  const merge = (current: Partial<Config>): Partial<Config> => patch.formatDurations === undefined
    ? { ...current, ...patch }
    : { ...current, formatDurations: mergeDurations(current.formatDurations, patch.formatDurations) };
  const configPath = file("config.json");
  if (readJson<Config | null>(configPath, null)?.setupDoneAt) {
    // Turning approval on marks what is already open and ungrouped, in the ledger's own write, before the config says on.
    if (patch.ownerGate === true) updateJson<Ledger>(file("ledger.json"), { requests: [] }, (l) => gateOpenRequests(l, Date.now()));
    const config = updateJson<Config | null>(configPath, null, (c) => validateConfig(merge(c!)));
    return { saved: field, config: config! };
  }
  const draft = updateJson<Partial<Config>>(file("config.draft.json"), {}, (d) => merge(d));
  const next = nextField(draft) ?? null;
  return { saved: field, next, question: next ? QUESTIONS[next] : null };
}

export function finish(register: () => unknown, now: number = Date.now()): { done: true; config: Config; crons: unknown } {
  const configPath = file("config.json");
  const draftPath = file("config.draft.json");
  const config = withLock(configPath, () => {
    const draft = readJson<Partial<Config> | null>(draftPath, null);
    const current = readJson<Config | null>(configPath, null);
    if (!draft) {
      if (current?.setupDoneAt) return current;
      throw new Error("there is no setup to finish; answer the setup questions first");
    }
    const done = { ...validateConfig({ ...current, ...draft }), setupDoneAt: new Date(now).toISOString() };
    writeJson(configPath, done);
    removeFile(draftPath);
    return done;
  });
  // config.json stays written if registration fails; --done can be re-run.
  return { done: true, config, crons: register() };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: { field: { type: "string" }, value: { type: "string" }, done: { type: "boolean" } },
    });
    if (values.done) {
      if (values.field !== undefined) throw new Error("pass --done alone");
      return finish(() => registerFromConfig());
    }
    if (values.field === undefined || values.value === undefined) {
      throw new Error("usage: record-setup.ts --field F --value V | --done");
    }
    return record(values.field, values.value);
  });
}
