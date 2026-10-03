import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dirname, "..", "skills", "meetly", "scripts");

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "meetly-"));
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
