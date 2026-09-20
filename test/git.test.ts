import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGitRepo, runGit } from "../lib/git.ts";
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

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-git-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runGit / isGitRepo", () => {
  it("reports a fresh directory as not a repo, then a repo", async () => {
    expect(await isGitRepo(testExec, dir)).toBe(false);
    await runGit(testExec, dir, ["init", "-b", "main"]);
    expect(await isGitRepo(testExec, dir)).toBe(true);
  });
});
