// Is Meetly set up? READY with the config and the calendar range to read,
// or SETUP_NEEDED with the next question.
import { isMain, run } from "./cli.ts";
import { DEFAULTS, nextField, normalizeConfig, QUESTIONS, type Config, type RequiredField } from "./config.ts";
import { ownerDisplayName } from "./owner-chat.ts";
import { macTimezone } from "./mac-timezone.ts";
import { LATCH_ABOUT_URL, LATCH_DOWNLOAD_URL, macConnected } from "./mac.ts";
import { record } from "./record-setup.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { localIso } from "./time.ts";

export type MacStatus = { connected: true } | { connected: false; download: string; about: string };
export type Status =
  | { status: "READY"; config: Config; range: { from: string; to: string } }
  | { status: "SETUP_NEEDED"; next: RequiredField | null; question: string | null; draft: Partial<Config>; defaults: typeof DEFAULTS; mac?: MacStatus };

export function status(now: number = Date.now()): Status {
  const stored = readJson<Config | null>(file("config.json"), null);
  const config = stored?.setupDoneAt ? normalizeConfig(stored) : stored;
  if (config?.setupDoneAt) {
    const to = now + (config.horizonDays + 1) * 86_400_000;
    return { status: "READY", config, range: { from: localIso(now, config.timezone), to: localIso(to, config.timezone) } };
  }
  const draft = readJson<Partial<Config>>(file("config.draft.json"), {});
  const next = nextField(draft) ?? null;
  return { status: "SETUP_NEEDED", next, question: next ? QUESTIONS[next] : null, draft, defaults: DEFAULTS };
}

// Setup asks only what nobody else can answer. The owner's name is the one on
// their Plow profile, and their time zone is the one their Mac is set to; each
// fills its question when setup reaches it, and is asked only when that source
// has no answer or cannot be reached. The owner can change either afterwards.
//
// The two questions that need the Mac, the time zone when the Mac did not
// answer it and the calendars, also say whether the Mac is connected, with
// where to get Plow Latch when it is not: without it there is nothing to read.
export type Lookups = {
  ownerName?: () => Promise<string | undefined>;
  timezone?: () => Promise<string | undefined>;
  mac?: () => Promise<boolean>;
};

const NEEDS_MAC: readonly (RequiredField | null)[] = ["timezone", "calendars"];

export async function statusFilling(lookups: Lookups = { ownerName: ownerDisplayName, timezone: macTimezone, mac: macConnected }, now: number = Date.now()): Promise<Status> {
  const current = await filled(lookups, now);
  if (current.status !== "SETUP_NEEDED" || !NEEDS_MAC.includes(current.next) || !lookups.mac) return current;
  const connected = await lookups.mac().catch(() => false);
  return { ...current, mac: connected ? { connected: true } : { connected: false, download: LATCH_DOWNLOAD_URL, about: LATCH_ABOUT_URL } };
}

// The name and the zone are looked up independently: a name Plow cannot give
// must not stop the Mac from giving the zone.
async function filled(lookups: Lookups, now: number): Promise<Status> {
  for (const field of ["ownerName", "timezone"] as const) {
    const current = status(now);
    if (current.status !== "SETUP_NEEDED" || current.draft[field] !== undefined || !lookups[field]) continue;
    try {
      const value = (await lookups[field]!())?.trim().slice(0, 60);
      if (value) record(field, value);
    } catch {
      // Left to the owner.
    }
  }
  return status(now);
}

if (isMain(import.meta.url)) run(() => statusFilling());
