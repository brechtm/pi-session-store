import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../lib/git.ts";
import { sessionRelPath, snapshotSession } from "../lib/snapshot.ts";
import type { ExecFn } from "../lib/types.ts";

const exec = promisify(execFile) as unknown as (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const testExec: ExecFn = async (command, args, options) => {
  try {
    const result = await exec(command, args, { cwd: options?.cwd });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
};

let store: string;
let sessionFile: string;
const sessionId = "01a0bc41-13e2-719d-b5c8-8051a593abda";

beforeEach(async () => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-"));
  await runGit(testExec, store, ["init", "-b", "main"]);
  await runGit(testExec, store, ["config", "user.email", "t@example.com"]);
  await runGit(testExec, store, ["config", "user.name", "Test"]);
  sessionFile = path.join(store, "..", `live-${sessionId}.jsonl`);
  fs.writeFileSync(
    sessionFile,
    '{"type":"session","version":3,"id":"' +
      sessionId +
      '","timestamp":"2026-09-20T00:00:00Z","cwd":"/tmp/proj"}\n',
  );
});
afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(sessionFile, { force: true });
});

async function commitCount(): Promise<number> {
  const r = await runGit(testExec, store, ["rev-list", "--count", "HEAD"]);
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

describe("snapshotSession", () => {
  it("writes the session file and creates a commit", async () => {
    const result = await snapshotSession({
      exec: testExec,
      storePath: store,
      sessionFile,
      sessionId,
      trigger: "commit",
    });
    expect(result.status).toBe("written");
    const dest = path.join(store, sessionRelPath(sessionId));
    expect(fs.existsSync(dest)).toBe(true);
    expect(await commitCount()).toBe(1);
  });

  it("is a no-op when content is unchanged", async () => {
    const params = {
      exec: testExec,
      storePath: store,
      sessionFile,
      sessionId,
      trigger: "commit" as const,
    };
    await snapshotSession(params);
    const result = await snapshotSession(params);
    expect(result.status).toBe("unchanged");
    expect(await commitCount()).toBe(1);
  });

  it("appends a new commit when the session grows", async () => {
    const params = {
      exec: testExec,
      storePath: store,
      sessionFile,
      sessionId,
      trigger: "commit" as const,
    };
    await snapshotSession(params);
    fs.appendFileSync(sessionFile, '{"type":"message","id":"x"}\n');
    const result = await snapshotSession(params);
    expect(result.status).toBe("written");
    expect(await commitCount()).toBe(2);
  });

  it("skips silently when the session file is missing", async () => {
    const result = await snapshotSession({
      exec: testExec,
      storePath: store,
      sessionFile: path.join(store, "nope.jsonl"),
      sessionId,
      trigger: "commit",
    });
    expect(result.status).toBe("skipped");
    expect(await commitCount()).toBe(0);
  });
});
