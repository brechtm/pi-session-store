import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import {
  aheadBehind,
  currentBranch,
  isGitRepo,
  remoteUrl,
  runGit,
} from "./git.ts";
import type { ExecFn } from "./types.ts";

export interface LastOutcome {
  at: string;
  status: string;
  message?: string;
}

export interface StatusInput {
  exec: ExecFn;
  configPath: string;
  config: Config | undefined;
  storePath?: string;
  sessionId?: string;
  sessionFile?: string;
  lastOutcome?: LastOutcome;
}

export interface StatusReport {
  text: string;
  level: "info" | "warning";
}

export async function buildStatus(input: StatusInput): Promise<StatusReport> {
  const lines: string[] = [];
  const { exec, configPath, config } = input;

  if (!config) {
    return {
      text: [
        "pi-session-store: not configured",
        `config file: ${configPath} (missing or invalid)`,
        'Create it with: { "path": "~/Code/pi-sessions", "push": true }',
      ].join("\n"),
      level: "warning",
    };
  }

  lines.push(`config file: ${configPath}`);
  lines.push(`store path: ${config.path}`);

  const storePath = input.storePath ?? config.path;
  const repo = await isGitRepo(exec, storePath);
  lines.push(`git repository: ${repo ? "yes" : "NO (extension disabled)"}`);
  if (!repo) {
    return { text: lines.join("\n"), level: "warning" };
  }

  const branch = await currentBranch(exec, storePath);
  lines.push(`branch: ${branch ?? "(detached)"}`);
  const remote = await remoteUrl(exec, storePath);
  lines.push(`remote: ${remote ?? "(none)"}`);

  if (await hasUpstreamSafe(exec, storePath)) {
    const counts = await aheadBehind(exec, storePath);
    lines.push(
      `sync: ${
        counts
          ? `${counts.ahead} ahead / ${counts.behind} behind upstream`
          : "upstream unknown"
      }`,
    );
  } else {
    lines.push("sync: no upstream configured (push disabled)");
  }

  if (input.sessionId) {
    lines.push(`session: ${input.sessionId}`);
    const stored = path.join(storePath, "sessions", `${input.sessionId}.jsonl`);
    if (fs.existsSync(stored)) {
      const stat = fs.statSync(stored);
      lines.push(
        `stored session: yes (${stat.size} bytes, modified ${stat.mtime.toISOString()})`,
      );
    } else {
      lines.push("stored session: no (not flushed yet)");
    }
  }
  if (input.sessionFile) {
    lines.push(`live session file: ${input.sessionFile}`);
  }
  if (input.lastOutcome) {
    const detail = input.lastOutcome.message
      ? ` (${input.lastOutcome.message})`
      : "";
    lines.push(
      `last snapshot: ${input.lastOutcome.status} at ${input.lastOutcome.at}${detail}`,
    );
  } else {
    lines.push("last snapshot: none this session");
  }

  return { text: lines.join("\n"), level: "info" };
}

async function hasUpstreamSafe(exec: ExecFn, dir: string): Promise<boolean> {
  const r = await runGit(exec, dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  return r.code === 0;
}
