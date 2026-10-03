import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Returns fallback only when the file does not exist. A file that exists but
// is not JSON throws: resetting it would re-read all history or lose holds.
export function readJson<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); fix or remove it by hand`);
  }
}

// Atomic: a temp file in the same directory, renamed over the target.
export function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export type LockOptions = {
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A per-file lock: `mkdir <path>.lock`. The poll and group turns can run at
// the same time, so every read-modify-write goes through here.
export function withLock<R>(path: string, fn: () => R, opts: LockOptions = {}): R {
  const waitMs = opts.waitMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepSync;
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let mtime: number | undefined;
    try {
      mtime = statSync(lock).mtimeMs;
    } catch {
      continue; // released between mkdir and stat
    }
    if (Date.now() - mtime > staleMs) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (now() >= deadline) throw new Error(`lock busy: ${lock}`);
    sleep(100);
  }
  const release = () => rmSync(lock, { recursive: true, force: true });
  let result: R;
  try {
    result = fn();
  } catch (err) {
    release();
    throw err;
  }
  // An async `fn` keeps the lock until it settles.
  if (result instanceof Promise) return result.finally(release) as R;
  release();
  return result;
}

export function updateJson<T>(path: string, fallback: T, fn: (v: T) => T): T {
  return withLock(path, () => {
    const next = fn(readJson(path, fallback));
    writeJson(path, next);
    return next;
  });
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
