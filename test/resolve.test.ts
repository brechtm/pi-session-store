import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../lib/git.ts";
import {
  extractSessionId,
  isUuid,
  openerFor,
  resolveSession,
  summarizeSession,
  viewHtmlPath,
} from "../lib/resolve.ts";
import type { ExecFn } from "../lib/types.ts";

const uuid = "01a0bc41-13e2-719d-b5c8-8051a593abda";

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

describe("isUuid", () => {
  it("accepts canonical UUIDs only", () => {
    expect(isUuid(uuid)).toBe(true);
    expect(isUuid("HEAD")).toBe(false);
    expect(isUuid("01a0bc41")).toBe(false);
  });
});

describe("extractSessionId", () => {
  it("finds the trailer among other trailers", () => {
    const message = [
      "fix: thing",
      "",
      "Co-Authored-By: Model <noreply@pi.dev>",
      "Generated-By: pi 0.86.0",
      `Pi-Session: ${uuid}`,
      "",
    ].join("\n");
    expect(extractSessionId(message)).toBe(uuid);
  });
  it("returns undefined when absent", () => {
    expect(extractSessionId("fix: thing\n")).toBeUndefined();
  });
});

describe("summarizeSession", () => {
  it("reads the header and counts entries", () => {
    const content = [
      `{"type":"session","version":3,"id":"${uuid}","timestamp":"2026-09-20T00:00:00Z","cwd":"/tmp/proj"}`,
      '{"type":"message","id":"a"}',
      '{"type":"message","id":"b"}',
      "",
    ].join("\n");
    expect(summarizeSession(content, uuid)).toEqual({
      sessionId: uuid,
      cwd: "/tmp/proj",
      startTime: "2026-09-20T00:00:00Z",
      entryCount: 2,
    });
  });
});

describe("viewHtmlPath / openerFor", () => {
  it("names the html by session id", () => {
    expect(viewHtmlPath("/cache", uuid)).toBe(`/cache/${uuid}.html`);
  });
  it("selects a platform opener", () => {
    expect(openerFor("darwin", "/x.html")).toEqual({
      command: "open",
      args: ["/x.html"],
    });
    expect(openerFor("linux", "/x.html")).toEqual({
      command: "xdg-open",
      args: ["/x.html"],
    });
    expect(openerFor("win32", "/x.html")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "/x.html"],
    });
  });
});

describe("resolveSession", () => {
  let work: string;
  let store: string;

  beforeEach(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-resolve-work-"));
    store = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-resolve-store-"));
    await runGit(testExec, work, ["init", "-b", "main"]);
    await runGit(testExec, work, ["config", "user.email", "t@example.com"]);
    await runGit(testExec, work, ["config", "user.name", "Test"]);
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("resolves a commit trailer to the stored file", async () => {
    fs.writeFileSync(path.join(work, "a.txt"), "hi\n");
    await runGit(testExec, work, ["add", "a.txt"]);
    await runGit(testExec, work, [
      "commit",
      "-m",
      `fix: thing\n\nPi-Session: ${uuid}`,
    ]);
    fs.mkdirSync(path.join(store, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(store, "sessions", `${uuid}.jsonl`), "{}\n");

    const result = await resolveSession({
      exec: testExec,
      storePath: store,
      cwd: work,
      arg: "HEAD",
    });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.sessionId).toBe(uuid);
      expect(fs.existsSync(result.file)).toBe(true);
    }
  });

  it("reports a commit without the trailer", async () => {
    fs.writeFileSync(path.join(work, "a.txt"), "hi\n");
    await runGit(testExec, work, ["add", "a.txt"]);
    await runGit(testExec, work, ["commit", "-m", "fix: no trailer"]);

    const result = await resolveSession({
      exec: testExec,
      storePath: store,
      cwd: work,
      arg: "HEAD",
    });
    expect(result.status).toBe("no-trailer");
  });

  it("reports a trailer whose session is absent from the store", async () => {
    fs.writeFileSync(path.join(work, "a.txt"), "hi\n");
    await runGit(testExec, work, ["add", "a.txt"]);
    await runGit(testExec, work, [
      "commit",
      "-m",
      `fix: thing\n\nPi-Session: ${uuid}`,
    ]);

    const result = await resolveSession({
      exec: testExec,
      storePath: store,
      cwd: work,
      arg: "HEAD",
    });
    expect(result.status).toBe("not-found");
  });

  it("accepts a bare UUID without touching git", async () => {
    fs.mkdirSync(path.join(store, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(store, "sessions", `${uuid}.jsonl`),
      `{"type":"session","id":"${uuid}"}\n`,
    );
    const result = await resolveSession({
      exec: testExec,
      storePath: store,
      cwd: work,
      arg: uuid,
    });
    expect(result.status).toBe("found");
  });
});
