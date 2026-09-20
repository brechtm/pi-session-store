import { describe, expect, it } from "vitest";
import { containsGitCommit } from "../lib/commit-detect.ts";

describe("containsGitCommit", () => {
  it("detects a plain commit", () => {
    expect(containsGitCommit('git commit -m "x"')).toBe(true);
    expect(containsGitCommit("git commit")).toBe(true);
  });

  it("detects commits through wrappers, options and chains", () => {
    expect(containsGitCommit("sudo git commit -m x")).toBe(true);
    expect(containsGitCommit("git -C /tmp/repo commit -m x")).toBe(true);
    expect(containsGitCommit("git -c user.name=x commit -m x")).toBe(true);
    expect(containsGitCommit("git add . && git commit -m x")).toBe(true);
    expect(containsGitCommit("echo hi; git commit; echo done")).toBe(true);
  });

  it("does not match unrelated git commands", () => {
    expect(containsGitCommit("git log --oneline")).toBe(false);
    expect(containsGitCommit("git status")).toBe(false);
    expect(containsGitCommit("git commit-tree HEAD^{tree}")).toBe(false);
    expect(containsGitCommit("echo 'we should commit later'")).toBe(false);
  });
});
