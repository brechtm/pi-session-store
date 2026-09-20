/**
 * pi-session-store
 *
 * Mirrors the active session's JSONL into a private git repository on every
 * commit-bearing turn and at session end, and exposes /session-store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configPath,
  isPathInside,
  loadConfig,
  type Config,
} from "./lib/config.ts";
import { containsGitCommit } from "./lib/commit-detect.ts";
import { isGitRepo, pullStore, pushStore } from "./lib/git.ts";
import { snapshotSession } from "./lib/snapshot.ts";
import {
  openerFor,
  renderHtml,
  resolveSession,
  viewHtmlPath,
} from "./lib/resolve.ts";
import { buildStatus, type LastOutcome } from "./lib/status.ts";
import type { ExecFn } from "./lib/types.ts";

interface Ui {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

interface Ctx {
  cwd: string;
  hasUI: boolean;
  ui: Ui;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
  };
}

interface PiApi {
  on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (
        prefix: string,
      ) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: Ctx) => Promise<void> | void;
    },
  ): void;
  exec: ExecFn;
}

// Module state is reset per extension instance; see __resetForTests.
let config: Config | undefined;
let storePath: string | undefined;
let sessionId: string | undefined;
let sessionFile: string | undefined;
let pendingCommit = false;
let lastOutcome: LastOutcome | undefined;
let currentExec: ExecFn | undefined;
const warned = new Set<string>();

export function __resetForTests(): void {
  config = undefined;
  storePath = undefined;
  sessionId = undefined;
  sessionFile = undefined;
  pendingCommit = false;
  lastOutcome = undefined;
  currentExec = undefined;
  warned.clear();
}

function execFor(): ExecFn {
  if (!currentExec) throw new Error("exec not bound");
  return currentExec;
}

function notifyOnce(ctx: Ctx, key: string, message: string): void {
  if (!ctx.hasUI || warned.has(key)) return;
  warned.add(key);
  ctx.ui.notify(message, "warning");
}

async function doSnapshot(
  ctx: Ctx,
  trigger: "commit" | "session-end",
): Promise<void> {
  if (!config || !storePath) return;
  const id = ctx.sessionManager.getSessionId() ?? sessionId;
  const file = ctx.sessionManager.getSessionFile() ?? sessionFile;
  if (!id || !file) return;
  const result = await snapshotSession({
    exec: execFor(),
    storePath,
    sessionFile: file,
    sessionId: id,
    trigger,
  });
  lastOutcome = {
    at: new Date().toISOString(),
    status: result.status,
    message: result.message,
  };
  if (result.status === "error") {
    notifyOnce(
      ctx,
      `snapshot:${result.message ?? "error"}`,
      `pi-session-store: ${result.message}`,
    );
  }
  if (config.push && result.status === "written") {
    const target = storePath;
    void pushStore(execFor(), target)
      .then((push) => {
        if (push.error) {
          lastOutcome = {
            at: new Date().toISOString(),
            status: "push-failed",
            message: push.error,
          };
          notifyOnce(ctx, "push-failed", `pi-session-store: push failed: ${push.error}`);
        }
      })
      .catch(() => {
        // push failures are non-fatal; never break the turn
      });
  }
}

export default function extension(pi: PiApi): void {
  currentExec = pi.exec;

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile();
    const loaded = loadConfig();
    if (!loaded.ok || !loaded.config || !loaded.config.enabled) {
      config = undefined;
      storePath = undefined;
      return;
    }
    config = loaded.config;
    storePath = config.path;
    if (!(await isGitRepo(pi.exec, storePath))) {
      notifyOnce(
        ctx,
        "no-repo",
        `pi-session-store: ${storePath} is not a git repository; disabled`,
      );
      config = undefined;
      storePath = undefined;
      return;
    }
    const pull = await pullStore(pi.exec, storePath);
    if (!pull.ok) {
      notifyOnce(ctx, "pull-failed", `pi-session-store: pull failed: ${pull.error}`);
    }
  });

  pi.on("tool_call", (event, ctx) => {
    if (!config || !storePath) return;
    const e = event as { toolName?: string; input?: { command?: unknown } };
    if (e.toolName !== "bash" || typeof e.input?.command !== "string") return;
    if (isPathInside(ctx.cwd, storePath)) return;
    if (containsGitCommit(e.input.command)) pendingCommit = true;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!pendingCommit) return;
    pendingCommit = false;
    await doSnapshot(ctx, "commit");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!config || !storePath) return;
    await doSnapshot(ctx, "session-end");
    if (config.push) {
      const push = await pushStore(execFor(), storePath);
      if (push.error) {
        notifyOnce(
          ctx,
          "push-failed-final",
          `pi-session-store: push failed: ${push.error}`,
        );
      }
    }
  });

  pi.registerCommand("session-store", {
    description: "Inspect or retrieve stored Pi session logs",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "get"].filter((s) => s.startsWith(prefix));
      return subs.length ? subs.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "status";
      if (sub === "status") {
        const report = await buildStatus({
          exec: pi.exec,
          configPath: configPath(),
          config,
          storePath,
          sessionId: ctx.sessionManager.getSessionId() ?? sessionId,
          sessionFile: ctx.sessionManager.getSessionFile() ?? sessionFile,
          lastOutcome,
        });
        ctx.ui.notify(report.text, report.level);
        return;
      }
      if (sub === "get") {
        if (!config || !storePath) {
          ctx.ui.notify("pi-session-store: not configured", "warning");
          return;
        }
        const view = tokens.includes("--view");
        const arg = tokens.slice(1).find((t) => t !== "--view");
        const result = await resolveSession({
          exec: pi.exec,
          storePath,
          cwd: ctx.cwd,
          arg,
        });
        if (result.status === "found") {
          const lines = [
            `session: ${result.sessionId}`,
            `file: ${result.file}`,
            `project: ${result.summary.cwd ?? "unknown"}`,
            `started: ${result.summary.startTime ?? "unknown"}`,
            `entries: ${result.summary.entryCount}`,
          ];
          if (view) {
            const cacheDir = path.join(os.tmpdir(), "pi-session-store-view");
            fs.mkdirSync(cacheDir, { recursive: true });
            const html = viewHtmlPath(cacheDir, result.sessionId);
            const rendered = await renderHtml(pi.exec, result.file, html);
            if (rendered.ok) {
              const opener = openerFor(process.platform, html);
              await pi.exec(opener.command, opener.args, { timeout: 10_000 });
              lines.push(`view: ${html}`);
            } else {
              lines.push(`view failed: ${rendered.error}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (result.status === "no-trailer") {
          ctx.ui.notify(`No Pi-Session trailer in ${result.rev}`, "warning");
          return;
        }
        if (result.status === "not-found") {
          ctx.ui.notify(
            `Session ${result.sessionId} not found in the store.\n` +
              `Expected: ${result.file}\n` +
              `Try /session-store status (not flushed, not pulled, or wrong store).`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(`pi-session-store: ${result.message}`, "warning");
        return;
      }
      ctx.ui.notify(
        "Usage: /session-store [status | get <rev|uuid> [--view]]",
        "warning",
      );
    },
  });
}
