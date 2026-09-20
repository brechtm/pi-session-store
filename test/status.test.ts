import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../lib/git.ts";
import { buildStatus } from "../lib/status.ts";
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
beforeEach(async () => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-status-"));
  await runGit(testExec, store, ["init", "-b", "main"]);
});
afterEach(() => fs.rmSync(store, { recursive: true, force: true }));

describe("buildStatus", () => {
  it("warns when there is no config", async () => {
    const report = await buildStatus({
      exec: testExec,
      configPath: "/nope/session-store.json",
      config: undefined,
    });
    expect(report.level).toBe("warning");
    expect(report.text).toContain("not configured");
  });

  it("reports store health and sync state for a real repo", async () => {
    const sessionId = "01a0bc41-13e2-719d-b5c8-8051a593abda";
    const sessionFile = path.join(store, "live.jsonl");
    fs.mkdirSync(path.join(store, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(store, "sessions", `${sessionId}.jsonl`), "{}\n");
    const report = await buildStatus({
      exec: testExec,
      configPath: "/tmp/session-store.json",
      config: { enabled: true, path: store, push: true },
      storePath: store,
      sessionId,
      sessionFile,
      lastOutcome: { at: "2026-09-20T01:00:00Z", status: "written" },
    });
    expect(report.level).toBe("info");
    expect(report.text).toContain("git repository: yes");
    expect(report.text).toContain("branch: main");
    expect(report.text).toContain("stored session: yes");
    expect(report.text).toContain("last snapshot: written");
  });

  it("warns when the configured store is not a git repo", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-notrepo-"));
    try {
      const report = await buildStatus({
        exec: testExec,
        configPath: "/tmp/session-store.json",
        config: { enabled: true, path: notRepo, push: true },
        storePath: notRepo,
      });
      expect(report.level).toBe("warning");
      expect(report.text).toContain("git repository: NO");
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
