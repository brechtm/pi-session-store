import * as fs from "node:fs";
import * as path from "node:path";
import { showCommitMessage } from "./git.ts";
import type { ExecFn } from "./types.ts";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function extractSessionId(message: string): string | undefined {
  for (const line of message.split(/\r?\n/)) {
    const match = /^\s*Pi-Session:\s*(\S+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

export interface SessionSummary {
  sessionId: string;
  cwd?: string;
  startTime?: string;
  entryCount: number;
}

export function summarizeSession(
  content: string,
  sessionId: string,
): SessionSummary {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  let cwd: string | undefined;
  let startTime: string | undefined;
  try {
    const header = JSON.parse(lines[0] ?? "");
    if (header && typeof header === "object") {
      if (typeof header.cwd === "string") cwd = header.cwd;
      if (typeof header.timestamp === "string") startTime = header.timestamp;
    }
  } catch {
    // tolerate a missing or non-JSON header
  }
  return { sessionId, cwd, startTime, entryCount: Math.max(0, lines.length - 1) };
}

export type ResolveResult =
  | { status: "found"; sessionId: string; file: string; summary: SessionSummary }
  | { status: "no-trailer"; rev: string }
  | { status: "not-found"; sessionId: string; file: string }
  | { status: "error"; message: string };

export interface ResolveParams {
  exec: ExecFn;
  storePath: string;
  cwd: string;
  arg?: string;
}

export async function resolveSession(
  params: ResolveParams,
): Promise<ResolveResult> {
  const { exec, storePath, cwd, arg } = params;
  let sessionId: string;

  if (arg && isUuid(arg)) {
    sessionId = arg;
  } else {
    const rev = arg && arg.trim() !== "" ? arg : "HEAD";
    let message: string | undefined;
    try {
      message = await showCommitMessage(exec, cwd, rev);
    } catch {
      message = undefined;
    }
    if (message === undefined) {
      return { status: "error", message: `could not read commit ${rev}` };
    }
    const found = extractSessionId(message);
    if (!found) return { status: "no-trailer", rev };
    sessionId = found;
  }

  const file = path.join(storePath, "sessions", `${sessionId}.jsonl`);
  try {
    const content = fs.readFileSync(file, "utf8");
    return {
      status: "found",
      sessionId,
      file,
      summary: summarizeSession(content, sessionId),
    };
  } catch {
    return { status: "not-found", sessionId, file };
  }
}

export function viewHtmlPath(cacheDir: string, sessionId: string): string {
  return path.join(cacheDir, `${sessionId}.html`);
}

export async function renderHtml(
  exec: ExecFn,
  jsonlPath: string,
  htmlPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await exec("pi", ["--export", jsonlPath, htmlPath], {
    timeout: 60_000,
  });
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: (result.stderr || result.stdout).trim() };
}

export function openerFor(
  platform: NodeJS.Platform,
  file: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [file] };
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", file] };
  }
  return { command: "xdg-open", args: [file] };
}
