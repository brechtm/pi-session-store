import type { ExecFn } from "./types.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

/** A git invocation succeeded only if it exited zero and was not killed. */
export function gitOk(result: GitResult): boolean {
  return result.code === 0 && !result.killed;
}

export async function runGit(
  exec: ExecFn,
  cwd: string,
  args: string[],
  timeout = 10_000,
): Promise<GitResult> {
  const result = await exec("git", ["-C", cwd, ...args], { cwd, timeout });
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    killed: result.killed ?? false,
  };
}

export async function isGitRepo(exec: ExecFn, dir: string): Promise<boolean> {
  return gitOk(await runGit(exec, dir, ["rev-parse", "--git-dir"]));
}

export async function hasUpstream(exec: ExecFn, dir: string): Promise<boolean> {
  return gitOk(
    await runGit(exec, dir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]),
  );
}

export async function pullStore(
  exec: ExecFn,
  dir: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await runGit(exec, dir, ["pull", "--ff-only"], 30_000);
  return gitOk(r)
    ? { ok: true }
    : { ok: false, error: (r.stderr || r.stdout).trim() || "git pull failed" };
}

export async function pushStore(
  exec: ExecFn,
  dir: string,
): Promise<{ pushed: boolean; skipped?: string; error?: string }> {
  if (!(await hasUpstream(exec, dir))) {
    return { pushed: false, skipped: "no upstream" };
  }
  const r = await runGit(exec, dir, ["push"], 30_000);
  return gitOk(r)
    ? { pushed: true }
    : { pushed: false, error: (r.stderr || r.stdout).trim() || "git push failed" };
}

export async function currentBranch(
  exec: ExecFn,
  dir: string,
): Promise<string | undefined> {
  // `branch --show-current` reports the branch even on an unborn HEAD (a fresh
  // repo with no commits), where `rev-parse --abbrev-ref` fails.
  const shown = await runGit(exec, dir, ["branch", "--show-current"]);
  const name = shown.stdout.trim();
  if (gitOk(shown) && name) return name;
  const r = await runGit(exec, dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const value = r.stdout.trim();
  return gitOk(r) && value && value !== "HEAD" ? value : undefined;
}

export async function remoteUrl(
  exec: ExecFn,
  dir: string,
  remote = "origin",
): Promise<string | undefined> {
  const r = await runGit(exec, dir, ["remote", "get-url", remote]);
  const value = r.stdout.trim();
  return gitOk(r) && value ? value : undefined;
}

export async function aheadBehind(
  exec: ExecFn,
  dir: string,
): Promise<{ ahead: number; behind: number } | undefined> {
  if (!(await hasUpstream(exec, dir))) return undefined;
  const r = await runGit(exec, dir, [
    "rev-list",
    "--count",
    "--left-right",
    "@{u}...HEAD",
  ]);
  if (!gitOk(r)) return undefined;
  const [behindText, aheadText] = r.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindText ?? "", 10);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return undefined;
  return { ahead, behind };
}

export async function showCommitMessage(
  exec: ExecFn,
  cwd: string,
  rev: string,
): Promise<string | undefined> {
  const r = await runGit(exec, cwd, ["show", "-s", "--format=%B", rev]);
  return gitOk(r) ? r.stdout : undefined;
}
