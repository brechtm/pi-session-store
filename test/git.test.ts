import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isGitRepo,
  pullStore,
  pushStore,
  runGit,
} from "../lib/git.ts";
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
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-git-"));
  await runGit(testExec, dir, ["init", "-b", "main"]);
  await runGit(testExec, dir, ["config", "user.email", "t@example.com"]);
  await runGit(testExec, dir, ["config", "user.name", "Test"]);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runGit / isGitRepo", () => {
  it("reports a fresh directory as not a repo, then a repo", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-git-fresh-"));
    try {
      expect(await isGitRepo(testExec, fresh)).toBe(false);
      await runGit(testExec, fresh, ["init", "-b", "main"]);
      expect(await isGitRepo(testExec, fresh)).toBe(true);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("pushStore / pullStore", () => {
  it("skips push when there is no upstream", async () => {
    const result = await pushStore(testExec, dir);
    expect(result.pushed).toBe(false);
    expect(result.skipped).toBe("no upstream");
  });

  it("pushes to a bare remote and pulls a fast-forward", async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-remote-"));
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-clone-"));
    try {
      await runGit(testExec, remote, ["init", "--bare", "-b", "main"]);
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      await runGit(testExec, dir, ["add", "a.txt"]);
      await runGit(testExec, dir, ["commit", "-m", "first"]);
      await runGit(testExec, dir, ["remote", "add", "origin", remote]);
      await runGit(testExec, dir, ["push", "-u", "origin", "main"]);
      await runGit(testExec, clone, ["clone", remote, clone]);

      fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
      await runGit(testExec, dir, ["add", "a.txt"]);
      await runGit(testExec, dir, ["commit", "-m", "second"]);
      const pushed = await pushStore(testExec, dir);
      expect(pushed.pushed).toBe(true);

      const pulled = await pullStore(testExec, clone);
      expect(pulled.ok).toBe(true);
      expect(fs.readFileSync(path.join(clone, "a.txt"), "utf8")).toBe("two\n");
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });

  it("treats a killed git process as a failure", async () => {
    const scripted: ExecFn = async (_command, args) => {
      if (args.includes("@{u}")) {
        return { stdout: "origin/main\n", stderr: "", code: 0 };
      }
      if (args.includes("push")) {
        return { stdout: "", stderr: "", code: 0, killed: true };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const result = await pushStore(scripted, "/tmp/pi-store-scripted");
    expect(result.pushed).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
