import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, REQUIRED_FIELDS, holdHours, loadConfig, parseField, parseTime, readableCalendars, validateConfig, type Config } from "../skills/meetly/scripts/config.ts";
import { finish, record } from "../skills/meetly/scripts/record-setup.ts";
import { status, statusFilling } from "../skills/meetly/scripts/setup-status.ts";
import { readJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const CALENDARS = JSON.stringify({ defaultAccount: "jean@example.com", calendars: [{ account: "jean@example.com", id: "work@group.calendar.google.com" }] });
const ANSWERS: [string, string][] = [
  ["ownerName", "Jean"],
  ["timezone", "America/Sao_Paulo"],
  ["days", "mon,tue,wed,thu,fri"],
  ["window", "09:00-18:00"],
  ["durationMin", "30"],
  ["horizonDays", "7"],
  ["calendars", CALENDARS],
];

function withHome<R>(fn: (home: string) => R): R {
  const saved = process.env.MEETLY_HOME;
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  try {
    return fn(home);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
}

test("empty home needs setup, starting with the owner's name", () => {
  withHome(() => {
    const s = status();
    assert.equal(s.status, "SETUP_NEEDED");
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "ownerName");
    assert.equal(s.status === "SETUP_NEEDED" && s.question, "When I talk to other people for you, I write about you by name, like \"Ana is free at 3pm\". What name should I use?");
  });
});

test("saved configurations without ownerGate require approval", () => {
  withHome((home) => {
    const legacy = {
      ownerName: "Jean", timezone: "America/Sao_Paulo", days: DEFAULTS.days,
      windowStart: "09:00", windowEnd: "18:00", durationMin: 30, horizonDays: 14,
      calendars: [{ account: "jean@example.com", id: "jean@example.com" }],
      defaultAccount: "jean@example.com", setupDoneAt: "2026-09-01T00:00:00.000Z",
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(legacy));
    const s = status();
    assert.equal(s.status, "READY");
    assert.equal(s.config.ownerGate, true);
    assert.equal(loadConfig().ownerGate, true);
  });
});

test("only what nobody can infer is asked: the name, the time zone and the calendars", () => {
  withHome(() => {
    assert.deepEqual([...REQUIRED_FIELDS], ["ownerName", "timezone", "calendars"]);
    const seen: (string | null)[] = [];
    for (const [field, value] of ANSWERS.filter(([f]) => (REQUIRED_FIELDS as readonly string[]).includes(f))) {
      const out = record(field, value);
      assert.ok("next" in out);
      seen.push(out.next);
    }
    assert.deepEqual(seen, ["timezone", "calendars", null]);
    const s = status();
    assert.equal(s.status === "SETUP_NEEDED" && s.next, null);
  });
});

test("the days, the hours and the horizon default, an answer given before finishing wins, and finishing fills the rest in", () => {
  assert.deepEqual(DEFAULTS, { days: ["mon", "tue", "wed", "thu", "fri"], windowStart: "09:00", windowEnd: "18:00", durationMin: 30, horizonDays: 14, ownerGate: true });
  withHome((home) => {
    record("ownerName", "Jean");
    record("timezone", "America/Sao_Paulo");
    record("calendars", CALENDARS);
    record("durationMin", "45");
    const s = status();
    assert.deepEqual(s.status === "SETUP_NEEDED" && s.defaults, DEFAULTS);
    finish(() => ({}), Date.parse("2026-09-26T12:00:00Z"));
    const config = readJson<Config | null>(join(home, "config.json"), null)!;
    assert.deepEqual([config.days, config.windowStart, config.windowEnd, config.durationMin, config.horizonDays],
      [DEFAULTS.days, "09:00", "18:00", 45, 14]);
    assert.equal(config.ownerGate, true);
    assert.equal(status().status, "READY");
  });
});

test("days are normalized to week order", () => {
  assert.deepEqual(parseField("days", "Mon, Tue ,wed"), { days: ["mon", "tue", "wed"] });
  assert.deepEqual(parseField("days", "friday monday Friday"), { days: ["mon", "fri"] });
  assert.throws(() => parseField("days", "funday"));
  assert.throws(() => parseField("days", " , "));
});

test("windows in natural form are accepted, backwards ones rejected", () => {
  const w = (v: string) => parseField("window", v);
  assert.deepEqual(w("9-18"), { windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(w("9h-18h"), { windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(w("09:00–18:00"), { windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(w("9:30 to 17"), { windowStart: "09:30", windowEnd: "17:00" });
  assert.deepEqual(w("9h30 até 17h"), { windowStart: "09:30", windowEnd: "17:00" });
  assert.deepEqual(w("10 a 16"), { windowStart: "10:00", windowEnd: "16:00" });
  assert.throws(() => w("18-9"));
  assert.throws(() => w("9"));
  assert.throws(() => w("9-25"));
});

test("parseTime accepts the documented shapes", () => {
  assert.equal(parseTime("9"), "09:00");
  assert.equal(parseTime("9h"), "09:00");
  assert.equal(parseTime("9:30"), "09:30");
  assert.equal(parseTime("9h30"), "09:30");
  assert.equal(parseTime("09:00"), "09:00");
  assert.throws(() => parseTime("9:75"));
});

test("an unknown time zone fails through the CLI", () => {
  const r = cli("record-setup.ts", ["--field", "timezone", "--value", "Mars/Olympus"], { MEETLY_HOME: tmpHome() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown time zone/);
  assert.equal(r.stdout, "");
});

test("durations and horizons are bounded integers", () => {
  assert.deepEqual(parseField("ownerGate", "on"), { ownerGate: true });
  assert.deepEqual(parseField("ownerGate", "off"), { ownerGate: false });
  assert.throws(() => parseField("ownerGate", "maybe"), /ownerGate/);
  // Movable blocks are title words the owner lists: lowercased, deduplicated, bounded; none clears them.
  assert.deepEqual(parseField("movable", " Prayer, GYM ,prayer "), { movable: ["prayer", "gym"] });
  assert.deepEqual(parseField("movable", "none"), { movable: undefined });
  assert.throws(() => parseField("movable", "a"), /movable/);
  assert.throws(() => parseField("movable", "x".repeat(41)), /movable/);
  assert.throws(() => parseField("movable", Array.from({ length: 21 }, (_, i) => `word${i}`).join(",")), /movable/);
  assert.throws(() => parseField("movable", " , "), /movable/);
  // Travel time around an in-person meeting: minutes (or an hour), 0 to 180, none clears it.
  for (const [value, min] of [["30", 30], ["45 min", 45], ["1h", 60], ["1.5h", 90], ["0", undefined], ["none", undefined]] as const) {
    assert.deepEqual(parseField("travel", value), { travelMin: min }, value);
  }
  for (const bad of ["soon", "-5", "181", "4h", ""]) assert.throws(() => parseField("travel", bad), /travel/, bad);
  // The video provider is Meet, or the owner's personal Zoom room (a strict https zoom.us URL).
  assert.deepEqual(parseField("videoProvider", "meet"), { zoomRoomUrl: undefined });
  const room = "https://us02web.zoom.us/j/123456789?pwd=abc.DEF";
  assert.deepEqual(parseField("videoProvider", ` ${room} `), { zoomRoomUrl: room });
  for (const bad of ["zoom", "http://zoom.us/j/1", "https://zoom.us.evil.example/j/1", "https://zoom.us/j/1?x=1", "https://example.com/j/1"]) {
    assert.throws(() => parseField("videoProvider", bad), /Zoom/, bad);
  }
  // The notice a time needs is hours or minutes, 0 to 72 hours, and default clears it.
  for (const [value, min] of [["3", 180], ["3h", 180], ["1.5h", 90], ["45 min", 45], ["0", 0]] as const) assert.deepEqual(parseField("minNotice", value), { minNoticeMin: min });
  assert.deepEqual(parseField("minNotice", "default"), { minNoticeMin: undefined });
  for (const bad of ["soon", "-1", "73h", "2 days"]) assert.throws(() => parseField("minNotice", bad), /notice/);
  assert.throws(() => parseField("durationMin", "5"));
  assert.throws(() => parseField("durationMin", "abc"));
  assert.throws(() => parseField("durationMin", "241"));
  assert.deepEqual(parseField("durationMin", "45"), { durationMin: 45 });
  assert.throws(() => parseField("horizonDays", "0"));
  assert.throws(() => parseField("horizonDays", "31"));
  assert.deepEqual(parseField("horizonDays", "14"), { horizonDays: 14 });
  // The default meeting type is one of three, and ask clears it.
  assert.deepEqual(parseField("defaultFormat", " in_person "), { defaultFormat: "in_person" });
  assert.deepEqual(parseField("defaultFormat", "ask"), { defaultFormat: undefined });
  assert.throws(() => parseField("defaultFormat", "zoom"), /meet, in_person, phone or ask/);
});

test("calendars always include the default account's primary, by the id the events listing takes", () => {
  assert.deepEqual(parseField("calendars", CALENDARS), {
    defaultAccount: "jean@example.com",
    calendars: [
      { account: "jean@example.com", id: "work@group.calendar.google.com" },
      { account: "jean@example.com", id: "jean@example.com" },
    ],
  });
  // `primary` and the account's address are the same calendar: one entry, never the alias.
  for (const ids of [["primary"], ["a@x"], ["a@x", "primary"], ["primary", "a@x"]]) {
    const value = JSON.stringify({ defaultAccount: "a@x", calendars: ids.map((id) => ({ account: "a@x", id })) });
    assert.deepEqual(parseField("calendars", value).calendars, [{ account: "a@x", id: "a@x" }], JSON.stringify(ids));
  }
  assert.deepEqual(readableCalendars([{ account: "b@x", id: "primary" }], "a@x"),
    [{ account: "b@x", id: "b@x" }, { account: "a@x", id: "a@x" }]);
  assert.throws(() => parseField("calendars", "not json"));
  assert.throws(() => parseField("calendars", JSON.stringify({ defaultAccount: "", calendars: [] })));
  assert.throws(() => parseField("calendars", JSON.stringify({ defaultAccount: "a@x", calendars: [{ account: "a@x" }] })));
});

test("a duration longer than the window is rejected", () => {
  const draft: Partial<Config> = {};
  for (const [f, v] of ANSWERS) Object.assign(draft, parseField(f, v));
  Object.assign(draft, parseField("window", "9-10"), parseField("durationMin", "90"));
  assert.throws(() => validateConfig(draft), /longer than/);
  // The same goes for a default length against a narrow window.
  const narrow: Partial<Config> = {};
  for (const [f, v] of ANSWERS.filter(([f]) => (REQUIRED_FIELDS as readonly string[]).includes(f))) Object.assign(narrow, parseField(f, v));
  Object.assign(narrow, parseField("window", "9-9:15"));
  assert.throws(() => validateConfig(narrow), /longer than/);
});

test("finish writes config, removes the draft, registers once", () => {
  withHome((home) => {
    for (const [f, v] of ANSWERS) record(f, v);
    let calls = 0;
    const out = finish(() => { calls++; return { paused: false, actions: [] }; }, Date.parse("2026-09-26T12:00:00Z"));
    assert.equal(calls, 1);
    assert.equal(out.done, true);
    const config = readJson<Config | null>(join(home, "config.json"), null);
    assert.equal(config?.setupDoneAt, "2026-09-26T12:00:00.000Z");
    assert.equal(existsSync(join(home, "config.draft.json")), false);
    finish(() => { calls++; }, Date.now());
    assert.equal(calls, 2);
  });
});

test("finish keeps config.json when registration fails", () => {
  withHome((home) => {
    for (const [f, v] of ANSWERS) record(f, v);
    assert.throws(() => finish(() => { throw new Error("scheduler down"); }, Date.now()), /scheduler down/);
    assert.ok(readJson<Config | null>(join(home, "config.json"), null)?.setupDoneAt);
  });
});

test("finish refuses a draft that still lacks the name, the time zone or the calendars", () => {
  withHome(() => {
    record("ownerName", "Jean");
    assert.throws(() => finish(() => undefined, Date.now()), /setup is missing: timezone, calendars/);
  });
});

test("editing a field after setup updates config.json and keeps setupDoneAt", () => {
  withHome((home) => {
    for (const [f, v] of ANSWERS) record(f, v);
    finish(() => undefined, Date.parse("2026-09-26T12:00:00Z"));
    const out = record("window", "10-17");
    assert.ok("config" in out);
    const config = readJson<Config | null>(join(home, "config.json"), null)!;
    assert.equal(config.windowStart, "10:00");
    assert.equal(config.windowEnd, "17:00");
    assert.equal("minNoticeMin" in config, false);
    record("minNotice", "1h");
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.minNoticeMin, 60);
    record("minNotice", "default");
    assert.equal("minNoticeMin" in readJson<object>(join(home, "config.json"), {}), false);
    assert.equal(config.setupDoneAt, "2026-09-26T12:00:00.000Z");
    record("ownerGate", "on");
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.ownerGate, true);
    // Only the owner's own turn (the plugin's meetly_set_owner_gate) turns approval off; a script run cannot.
    assert.throws(() => record("ownerGate", "off"), /meetly_set_owner_gate/);
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.ownerGate, true);
    record("ownerGate", "off", { ownerTurn: true });
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.ownerGate, false);
    assert.equal(loadConfig().ownerGate, false);
    const standingAuthorization = status();
    assert.equal(standingAuthorization.status === "READY" && standingAuthorization.config.ownerGate, false);
    record("travel", "30");
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.travelMin, 30);
    record("travel", "none");
    assert.equal("travelMin" in readJson<object>(join(home, "config.json"), {}), false);
    record("movable", "prayer, gym");
    assert.deepEqual(readJson<Config | null>(join(home, "config.json"), null)!.movable, ["prayer", "gym"]);
    record("movable", "none");
    assert.equal("movable" in readJson<object>(join(home, "config.json"), {}), false);
    record("videoProvider", "https://zoom.us/j/123456789");
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.zoomRoomUrl, "https://zoom.us/j/123456789");
    record("videoProvider", "meet");
    assert.equal("zoomRoomUrl" in readJson<object>(join(home, "config.json"), {}), false);
    assert.equal("defaultFormat" in config, false);
    record("defaultFormat", "meet");
    assert.equal(readJson<Config | null>(join(home, "config.json"), null)!.defaultFormat, "meet");
    record("defaultFormat", "ask");
    assert.equal("defaultFormat" in readJson<object>(join(home, "config.json"), {}), false);
    assert.throws(() => record("durationMin", "600"));
    assert.throws(() => record("color", "blue"), /unknown field/);
  });
});

test("READY carries the calendar range in the owner's zone", () => {
  withHome(() => {
    for (const [f, v] of ANSWERS) record(f, v);
    finish(() => undefined, Date.parse("2026-09-26T12:00:00Z"));
    const s = status(Date.parse("2026-09-28T11:00:00Z"));
    assert.equal(s.status, "READY");
    assert.deepEqual(s.status === "READY" && s.range, { from: "2026-09-28T08:00:00-03:00", to: "2026-10-06T08:00:00-03:00" });
  });
});

test("the setup status instruction reports the configured default meeting type", () => {
  const skill = readFileSync(join(import.meta.dirname, "../skills/meetly-setup/SKILL.md"), "utf8");
  assert.match(skill, /default meeting type \(or "ask each time" when `config\.defaultFormat` is\s+unset\)/);
});

test("the CLI walks setup and finishes", () => {
  const home = tmpHome();
  const first = cli("setup-status.ts", [], { MEETLY_HOME: home });
  assert.equal(first.json.status, "SETUP_NEEDED");
  const r = cli("record-setup.ts", ["--field", "ownerName", "--value", "Jean"], { MEETLY_HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.json.next, "timezone");
  const done = cli("record-setup.ts", ["--done"], { MEETLY_HOME: home });
  assert.equal(done.status, 1);
  assert.match(done.stderr, /^error: /);
});

test("hold hours default to 48 and accept an override", () => {
  const saved = process.env.MEETLY_HOLD_HOURS;
  try {
    delete process.env.MEETLY_HOLD_HOURS;
    assert.equal(holdHours(), 48);
    process.env.MEETLY_HOLD_HOURS = "0.1";
    assert.equal(holdHours(), 0.1);
    process.env.MEETLY_HOLD_HOURS = "-1";
    assert.equal(holdHours(), 48);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOLD_HOURS;
    else process.env.MEETLY_HOLD_HOURS = saved;
  }
});

test("the owner's Plow profile name answers the first question, so setup starts at the time zone", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    const s = await statusFilling({ ownerName: async () => "  Jean Jacintho " });
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "timezone");
    assert.equal(s.status === "SETUP_NEEDED" && s.draft.ownerName, "Jean Jacintho");
    // Once filled it is not looked up again, and the owner can still change it.
    const again = await statusFilling({ ownerName: async () => { throw new Error("not called"); } });
    assert.equal(again.status === "SETUP_NEEDED" && again.next, "timezone");
    record("ownerName", "Jean");
    assert.equal(status().status === "SETUP_NEEDED" && (status() as { draft: { ownerName?: string } }).draft.ownerName, "Jean");
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("with no name on Plow, or Plow unreachable, the owner is asked", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    for (const lookup of [async () => undefined, async () => "   ", async () => { throw new Error("down"); }]) {
      const s = await statusFilling({ ownerName: lookup });
      assert.equal(s.status === "SETUP_NEEDED" && s.next, "ownerName");
    }
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("the Mac's time zone answers its question right after the name, so setup is left with the calendars", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    const s = await statusFilling({ ownerName: async () => "Ana Lima", timezone: async () => "America/Sao_Paulo" });
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "calendars");
    assert.deepEqual(s.status === "SETUP_NEEDED" && [s.draft.ownerName, s.draft.timezone], ["Ana Lima", "America/Sao_Paulo"]);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("a missing name does not stop the Mac's time zone from being filled, so the owner is never asked for what the Mac knows", async () => {
  await withHomeAsync(async () => {
    const s = await statusFilling({ ownerName: async () => undefined, timezone: async () => "America/Sao_Paulo", mac: async () => true });
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "ownerName");
    assert.deepEqual(s.status === "SETUP_NEEDED" && [s.draft.ownerName, s.draft.timezone], [undefined, "America/Sao_Paulo"]);
    // After the owner gives a name, the next question is the calendars, not the zone again.
    const answered = record("ownerName", "Ana");
    assert.ok("next" in answered && answered.next === "calendars");
  });
});

test("a Mac that cannot answer, or answers something that is not a zone, leaves the question to the owner", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    for (const timezone of [async () => undefined, async () => { throw new Error("no Mac"); }, async () => "Not/AZone"]) {
      const s = await statusFilling({ ownerName: async () => "Ana", timezone });
      assert.equal(s.status === "SETUP_NEEDED" && s.next, "timezone");
    }
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});


const noProbe = async (): Promise<boolean> => { throw new Error("the Mac is not probed here"); };

async function withHomeAsync(fn: (home: string) => Promise<void>): Promise<void> {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    await fn(process.env.MEETLY_HOME);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
}

test("at the calendars question a Mac that is not connected is reported with the Plow Latch links", async () => {
  await withHomeAsync(async () => {
    for (const [field, value] of ANSWERS.slice(0, 6)) record(field as never, value);
    const s = await statusFilling({ mac: async () => false });
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "calendars");
    assert.deepEqual(s.status === "SETUP_NEEDED" && s.mac,
      { connected: false, download: "https://plow.co/download/latch", about: "https://plow.co/latch" });
    const on = await statusFilling({ mac: async () => true });
    assert.deepEqual(on.status === "SETUP_NEEDED" && on.mac, { connected: true });
  });
});

test("a time zone left for the owner says whether the Mac is connected; a finished draft and READY never probe it", async () => {
  await withHomeAsync(async () => {
    const tz = await statusFilling({ ownerName: async () => "Ana", timezone: async () => undefined, mac: async () => false });
    assert.equal(tz.status === "SETUP_NEEDED" && tz.next, "timezone");
    assert.equal(tz.status === "SETUP_NEEDED" && tz.mac?.connected, false);
    record("timezone", "America/Sao_Paulo");
    const cals = await statusFilling({ mac: async () => true });
    assert.equal(cals.status === "SETUP_NEEDED" && cals.next, "calendars");
    assert.deepEqual(cals.status === "SETUP_NEEDED" && cals.mac, { connected: true });
    record("calendars", CALENDARS);
    const done = await statusFilling({ mac: noProbe });
    assert.equal(done.status === "SETUP_NEEDED" && done.mac, undefined);
    finish(() => ({}));
    assert.equal((await statusFilling({ mac: noProbe })).status, "READY");
  });
});
