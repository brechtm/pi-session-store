import { describe, expect, it } from "vitest";
import extension, { __resetForTests } from "../index.ts";

interface Registered {
  events: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  commands: Record<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >;
}

function makeFake() {
  const registered: Registered = { events: {}, commands: {} };
  const notifications: Array<{ message: string; level?: string }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (registered.events[event] ??= []).push(handler);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      registered.commands[name] = options;
    },
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionId: () => "01a0bc41-13e2-719d-b5c8-8051a593abda",
      getSessionFile: () => "/tmp/project/session.jsonl",
    },
  };
  return { pi, ctx, registered, notifications, execCalls };
}

describe("extension wiring", () => {
  it("registers the session-store command and the four event handlers", () => {
    __resetForTests();
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
    __resetForTests();
    const { pi, registered, notifications, ctx } = makeFake();
    extension(pi as never);
    await registered.commands["session-store"].handler("bogus", ctx);
    expect(notifications.at(-1)?.message.toLowerCase()).toContain("usage");
  });

  it("reports not-configured for get without a config", async () => {
    __resetForTests();
    const { pi, registered, notifications, ctx } = makeFake();
    extension(pi as never);
    await registered.commands["session-store"].handler("get HEAD", ctx);
    expect(notifications.at(-1)?.message).toContain("not configured");
  });
});
