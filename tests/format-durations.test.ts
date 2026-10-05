import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { durationFor, mergeDurations, parseField, validateConfig, type Config } from "../skills/meetly/scripts/config.ts";
import { finish, record } from "../skills/meetly/scripts/record-setup.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, testConfig, tmpHome } from "./helpers.ts";

const CONFIG = testConfig();

test("a format's length is parsed from what the owner says, and default goes back to the usual length", () => {
  assert.deepEqual(parseField("formatDuration", "in_person 60"), { formatDurations: { in_person: 60 } });
  assert.deepEqual(parseField("formatDuration", "phone=15 min"), { formatDurations: { phone: 15 } });
  assert.deepEqual(parseField("formatDuration", "meet: 45"), { formatDurations: { meet: 45 } });
  assert.deepEqual(parseField("formatDuration", "meet default"), { formatDurations: { meet: undefined } });
  for (const bad of ["lunch 60", "phone", "phone 5", "phone 300", "in_person sixty"]) {
    assert.throws(() => parseField("formatDuration", bad), /formatDuration|duration/, bad);
  }
});

test("a request with no length takes its format's, then the usual one", () => {
  const config = { ...CONFIG, formatDurations: { in_person: 60, phone: 15 } };
  assert.equal(durationFor(config, "in_person"), 60);
  assert.equal(durationFor(config, "phone"), 15);
  assert.equal(durationFor(config, "meet"), 30);
  assert.equal(durationFor(config, "unknown"), 30);
  assert.equal(durationFor(config), 30);
  assert.equal(durationFor(CONFIG, "in_person"), 30);
});

test("lengths are merged one format at a time and validated against the window", () => {
  assert.deepEqual(mergeDurations({ phone: 15 }, { in_person: 60 }), { phone: 15, in_person: 60 });
  assert.deepEqual(mergeDurations({ phone: 15 }, { phone: undefined }), undefined);
  assert.throws(() => validateConfig({ ...CONFIG, windowStart: "09:00", windowEnd: "10:00", formatDurations: { in_person: 90 } }), /longer than the 09:00-10:00 window/);
  assert.throws(() => validateConfig({ ...CONFIG, formatDurations: { lunch: 60 } as never }), /unknown format/);
  assert.deepEqual(validateConfig({ ...CONFIG, formatDurations: { phone: 15 } }).formatDurations, { phone: 15 });
});

test("record-setup keeps the other formats when one changes", () => {
  const saved = process.env.MEETLY_HOME;
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  try {
    writeJson(join(home, "config.draft.json"), { ...CONFIG, setupDoneAt: undefined });
    finish(() => undefined);
    record("formatDuration", "in_person 60");
    record("formatDuration", "phone 15");
    assert.deepEqual(readJson<Config | null>(join(home, "config.json"), null)!.formatDurations, { in_person: 60, phone: 15 });
    record("formatDuration", "in_person default");
    assert.deepEqual(readJson<Config | null>(join(home, "config.json"), null)!.formatDurations, { phone: 15 });
    record("formatDuration", "phone default");
    assert.equal("formatDurations" in readJson<object>(join(home, "config.json"), {}), false);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("slots.ts uses the format's length unless --duration names one", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { ...CONFIG, formatDurations: { in_person: 60 } });
  const busyFile = join(home, "busy.json");
  writeFileSync(busyFile, JSON.stringify({ busy: [] }));
  const env = { MEETLY_HOME: home };
  const now = ["--now", "2026-09-28T08:00:00-03:00", "--count", "1"];
  const length = (args: string[]) => {
    const r = cli("slots.ts", ["--in", busyFile, ...now, ...args], env);
    assert.equal(r.status, 0, r.stderr);
    const slot = r.json.slots[0];
    return (Date.parse(slot.end) - Date.parse(slot.start)) / 60_000;
  };
  assert.equal(length(["--format", "in_person"]), 60);
  assert.equal(length(["--format", "meet"]), 30);
  assert.equal(length([]), 30);
  assert.equal(length(["--format", "in_person", "--duration", "45"]), 45);
  const at = cli("slots.ts", ["--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--at", "2026-09-29T10:00:00-03:00", "--format", "in_person"], env);
  assert.equal(at.json.slot.end, "2026-09-29T11:00:00-03:00");
});
