import * as fs from "node:fs";
import * as path from "node:path";
import { gitOk, runGit, type GitResult } from "./git.ts";
import type { ExecFn } from "./types.ts";

export type SnapshotTrigger = "commit" | "session-end";

export interface SnapshotParams {
  exec: ExecFn;
  storePath: string;
  sessionFile: string;
  sessionId: string;
  trigger: SnapshotTrigger;
  /** Injected for tests to avoid real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Capped exponential backoff delays between index-lock retries. */
  retryDelaysMs?: number[];
}

export interface SnapshotResult {
  status: "written" | "unchanged" | "skipped" | "error";
  message?: string;
}

export function sessionRelPath(sessionId: string): string {
  return path.join("sessions", `${sessionId}.jsonl`);
}

const DEFAULT_RETRY_DELAYS = [50, 100, 200];
const LOCK_RE =
  /index\.lock|Another git process seems to be running|unable to create.*index\.lock/i;

async function runGitWithLockRetry(
  exec: ExecFn,
  storePath: string,
  args: string[],
  sleep: (ms: number) => Promise<void>,
  delays: number[],
): Promise<GitResult> {
  let result = await runGit(exec, storePath, args);
  for (const delay of delays) {
    if (gitOk(result) || !LOCK_RE.test(`${result.stdout}\n${result.stderr}`)) {
      return result;
    }
    await sleep(delay);
    result = await runGit(exec, storePath, args);
  }
  return result;
}

export async function snapshotSession(
  params: SnapshotParams,
): Promise<SnapshotResult> {
  const {
    exec,
    storePath,
    sessionFile,
    sessionId,
    trigger,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    retryDelaysMs = DEFAULT_RETRY_DELAYS,
  } = params;

  let content: Buffer;
  try {
    content = fs.readFileSync(sessionFile);
  } catch {
    return { status: "skipped", message: "session file not available" };
  }

  const rel = sessionRelPath(sessionId);
  const dest = path.join(storePath, rel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  } catch (error) {
    return {
      status: "error",
      message: `cannot write session file: ${String(error)}`,
    };
  }

  const add = await runGitWithLockRetry(
    exec,
    storePath,
    ["add", "--", rel],
    sleep,
    retryDelaysMs,
  );
  if (!gitOk(add)) {
    return {
      status: "error",
      message: `git add failed: ${(add.stderr || add.stdout).trim()}`,
    };
  }

  const message = `Snapshot ${sessionId} (${trigger})`;
  const commit = await runGitWithLockRetry(
    exec,
    storePath,
    ["commit", "-m", message, "--", rel],
    sleep,
    retryDelaysMs,
  );
  if (!gitOk(commit)) {
    const output = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit|no changes added/i.test(output)) {
      return { status: "unchanged" };
    }
    return { status: "error", message: `git commit failed: ${output.trim()}` };
  }
  return { status: "written" };
}
