import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
