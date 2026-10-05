import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../skills/meetly/scripts/config.ts";

const SCRIPTS = resolve(import.meta.dirname, "..", "skills", "meetly", "scripts");

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "meetly-"));
}

// A ledger holding one open request, for the scripts that act on a saved request.
export function seedRequest(home: string, over: Record<string, unknown> = {}): void {
  const at = "2026-09-28T12:00:00.000Z";
  const request = {
    id: "r_1", origin: "owner", handle: "+15551234567", topic: "coffee", durationMin: 30, status: "offered",
    offered: [], offeredAt: at, createdAt: at, updatedAt: at, ...over,
  };
  writeFileSync(join(home, "ledger.json"), JSON.stringify({ requests: [request] }));
}

// A finished configuration, for the suites that build one in memory.
export const testConfig = (over: Partial<Config> = {}): Config => ({
  ownerName: "Jean", timezone: "America/Sao_Paulo", days: ["mon", "tue", "wed", "thu", "fri"], windowStart: "09:00", windowEnd: "18:00",
  durationMin: 30, horizonDays: 7, calendars: [{ account: "jean@example.com", id: "primary" }], defaultAccount: "jean@example.com",
  setupDoneAt: "2026-09-26T12:00:00.000Z", ...over,
});

// A finished setup in the data dir, for the scripts that read the configuration (the gate is on unless overridden).
export function writeConfig(home: string, over: Record<string, unknown> = {}): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({
    ownerName: "Jean", timezone: "America/Sao_Paulo", days: ["mon"], windowStart: "09:00", windowEnd: "18:00", durationMin: 30, horizonDays: 7,
    calendars: [{ account: "a@example.com", id: "a@example.com" }], defaultAccount: "a@example.com", setupDoneAt: "2026-09-28T12:00:00.000Z", ...over,
  }));
}

// Creates a request through the CLI the way the skills do (`ledger.ts save`), with a finished setup that has the gate off.
export function saveCli(env: Record<string, string>, request: object): CliResult {
  if (!existsSync(join(env.MEETLY_HOME!, "config.json"))) writeConfig(env.MEETLY_HOME!, { ownerGate: false });
  return cli("ledger.ts", ["save", "--json", JSON.stringify(request)], env);
}

// A handle reaches a script only through a JSON array file, never the command line.
export function handlesFile(...handles: string[]): string {
  const path = join(tmpHome(), "handles.json");
  writeFileSync(path, JSON.stringify(handles));
  return path;
}

export type CliResult = { status: number | null; stdout: string; stderr: string; json: any };

export function cli(script: string, args: string[], env: Record<string, string>, input?: string): CliResult {
  const proc = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
  let json: unknown;
  try {
    json = proc.stdout.trim() ? JSON.parse(proc.stdout) : undefined;
  } catch {
    json = undefined;
  }
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, json };
}

export type MacCall = { argv: string[] };

// The Mac's Latch bridge as plow_run_command answers it: one SSE data line with the command's JSON result.
export function macBridge(reply: (argv: string[]) => string | undefined, calls: MacCall[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const argv = JSON.parse(String(init?.body)).params.arguments.argv as string[];
    calls.push({ argv });
    const output = reply(argv);
    const out = output === undefined ? { exit_code: 1, output: "gog: 401" } : { exit_code: 0, output };
    const result = { content: [{ type: "text", text: JSON.stringify(out) }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`);
  }) as typeof fetch;
}
