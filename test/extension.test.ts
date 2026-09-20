import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import extension, { __resetForTests } from "../index.ts";
import { runGit } from "../lib/git.ts";
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

const temp: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temp.push(dir);
  return dir;
}

async function makeStore(): Promise<string> {
  const store = tmp("pi-store-ext-store-");
  await runGit(testExec, store, ["init", "-b", "main"]);
  await runGit(testExec, store, ["config", "user.email", "t@example.com"]);
  await runGit(testExec, store, ["config", "user.name", "Test"]);
  return store;
}

function writeConfig(value: Record<string, unknown>): string {
  const file = path.join(tmp("pi-store-ext-cfg-"), "session-store.json");
  fs.writeFileSync(file, JSON.stringify(value));
  process.env.PI_SESSION_STORE_CONFIG = file;
  return file;
}

function writeLiveSession(): string {
  const file = path.join(tmp("pi-store-ext-live-"), `${uuid}.jsonl`);
  fs.writeFileSync(
    file,
    `{"type":"session","version":3,"id":"${uuid}","timestamp":"2026-09-20T00:00:00Z","cwd":"/tmp/proj"}\n`,
  );
  return file;
}

interface Registered {
  events: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  commands: Record<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >;
}

function makeFake(options: {
  exec?: ExecFn;
  cwd?: string;
  sessionFile?: string;
} = {}) {
  const registered: Registered = { events: {}, commands: {} };
  const notifications: Array<{ message: string; level?: string }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (registered.events[event] ??= []).push(handler);
    },
    registerCommand(
      name: string,
      opts: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      registered.commands[name] = opts;
    },
    exec:
      options.exec ??
      (async () => ({ stdout: "", stderr: "", code: 0 })),
  };
  const ctx = {
    cwd: options.cwd ?? "/tmp/project",
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionId: () => uuid,
      getSessionFile: () => options.sessionFile ?? "/tmp/project/session.jsonl",
    },
  };
  return { pi, ctx, registered, notifications };
}

async function commitCount(repo: string): Promise<number> {
  const r = await runGit(testExec, repo, ["rev-list", "--count", "HEAD"]);
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

afterEach(() => {
  delete process.env.PI_SESSION_STORE_CONFIG;
  __resetForTests();
  while (temp.length) fs.rmSync(temp.pop() as string, { recursive: true, force: true });
});

describe("extension wiring", () => {
  it("registers the session-store command and the four event handlers", () => {
    const { pi, registered } = makeFake();
    extension(pi as never);
    expect(Object.keys(registered.commands)).toContain("session-store");
    expect(Object.keys(registered.events).sort()).toEqual([
      "session_shutdown",
      "session_start",
      "tool_call",
      "turn_end",
    ]);
  });

  it("reports unknown subcommands without throwing", async () => {
    const { pi, registered, notifications, ctx } = makeFake();
    extension(pi as never);
    await registered.commands["session-store"].handler("bogus", ctx);
    expect(notifications.at(-1)?.message.toLowerCase()).toContain("usage");
  });

  it("reports not-configured for get without a config", async () => {
    const { pi, registered, notifications, ctx } = makeFake();
    extension(pi as never);
    await registered.commands["session-store"].handler("get HEAD", ctx);
    expect(notifications.at(-1)?.message).toContain("not configured");
  });

  it("disables itself and warns when the store is not a git repo", async () => {
    const notRepo = tmp("pi-store-ext-notrepo-");
    writeConfig({ path: notRepo });
    const { pi, registered, notifications, ctx } = makeFake({ exec: testExec });
    extension(pi as never);
    await registered.events["session_start"][0]({}, ctx);
    expect(notifications.some((n) => n.message.includes("not a git repository"))).toBe(true);
  });

  it("snapshots on turn_end after a commit-bearing bash call", async () => {
    const store = await makeStore();
    writeConfig({ path: store });
    const live = writeLiveSession();
    const { pi, registered, ctx } = makeFake({
      exec: testExec,
      cwd: "/tmp/project",
      sessionFile: live,
    });
    extension(pi as never);
    await registered.events["session_start"][0]({}, ctx);
    await registered.events["tool_call"][0](
      { toolName: "bash", input: { command: 'git commit -m "x"' } },
      ctx,
    );
    await registered.events["turn_end"][0]({}, ctx);

    const stored = path.join(store, "sessions", `${uuid}.jsonl`);
    expect(fs.existsSync(stored)).toBe(true);
    expect(await commitCount(store)).toBe(1);
  });

  it("does not snapshot when cwd is inside the store", async () => {
    const store = await makeStore();
    writeConfig({ path: store });
    const live = writeLiveSession();
    const { pi, registered, ctx } = makeFake({
      exec: testExec,
      cwd: store,
      sessionFile: live,
    });
    extension(pi as never);
    await registered.events["session_start"][0]({}, ctx);
    await registered.events["tool_call"][0](
      { toolName: "bash", input: { command: 'git commit -m "x"' } },
      ctx,
    );
    await registered.events["turn_end"][0]({}, ctx);

    expect(fs.existsSync(path.join(store, "sessions", `${uuid}.jsonl`))).toBe(false);
    expect(await commitCount(store)).toBe(0);
  });

  it("flushes the session at shutdown even without commits", async () => {
    const store = await makeStore();
    writeConfig({ path: store });
    const live = writeLiveSession();
    const { pi, registered, ctx } = makeFake({
      exec: testExec,
      cwd: "/tmp/project",
      sessionFile: live,
    });
    extension(pi as never);
    await registered.events["session_start"][0]({}, ctx);
    await registered.events["session_shutdown"][0]({}, ctx);

    expect(fs.existsSync(path.join(store, "sessions", `${uuid}.jsonl`))).toBe(true);
    expect(await commitCount(store)).toBe(1);
  });

  it("keeps the local commit when push is disabled", async () => {
    const store = await makeStore();
    writeConfig({ path: store, push: false });
    const live = writeLiveSession();
    const { pi, registered, ctx } = makeFake({
      exec: testExec,
      cwd: "/tmp/project",
      sessionFile: live,
    });
    extension(pi as never);
    await registered.events["session_start"][0]({}, ctx);
    await registered.events["tool_call"][0](
      { toolName: "bash", input: { command: 'git commit -m "x"' } },
      ctx,
    );
    await registered.events["turn_end"][0]({}, ctx);

    expect(await commitCount(store)).toBe(1);
  });
});
