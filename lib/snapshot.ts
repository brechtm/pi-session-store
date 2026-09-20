import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./git.ts";
import type { ExecFn } from "./types.ts";

export type SnapshotTrigger = "commit" | "session-end";

export interface SnapshotParams {
  exec: ExecFn;
  storePath: string;
  sessionFile: string;
  sessionId: string;
  trigger: SnapshotTrigger;
}

export interface SnapshotResult {
  status: "written" | "unchanged" | "skipped" | "error";
  message?: string;
}

export function sessionRelPath(sessionId: string): string {
  return path.join("sessions", `${sessionId}.jsonl`);
}

export async function snapshotSession(
  params: SnapshotParams,
): Promise<SnapshotResult> {
  const { exec, storePath, sessionFile, sessionId, trigger } = params;

  let content: Buffer;
  try {
    content = fs.readFileSync(sessionFile);
  } catch {
    return { status: "skipped", message: "session file not available" };
  }

  const rel = sessionRelPath(sessionId);
  const dest = path.join(storePath, rel);
  try {
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(content)) {
      return { status: "unchanged" };
    }
  } catch {
    // fall through and overwrite
  }

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  } catch (error) {
    return {
      status: "error",
      message: `cannot write session file: ${String(error)}`,
    };
  }

  const add = await runGit(exec, storePath, ["add", "--", rel]);
  if (add.code !== 0) {
    return {
      status: "error",
      message: `git add failed: ${(add.stderr || add.stdout).trim()}`,
    };
  }

  const message = `Snapshot ${sessionId} (${trigger})`;
  const commit = await runGit(exec, storePath, [
    "commit",
    "-m",
    message,
    "--",
    rel,
  ]);
  if (commit.code !== 0) {
    const output = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit|no changes added/i.test(output)) {
      return { status: "unchanged" };
    }
    return { status: "error", message: `git commit failed: ${output.trim()}` };
  }
  return { status: "written" };
}
