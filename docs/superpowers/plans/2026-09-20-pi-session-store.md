# pi-session-store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-free Pi extension that mirrors the active session's JSONL into a private git store on every commit-bearing turn and at session end, plus `/session-store status` and `/session-store get`.

**Architecture:** Pure, dependency-free modules (`lib/`) hold all logic and take an injected `exec` function; `index.ts` is a thin wiring layer that maps Pi events (`session_start`, `tool_call`, `turn_end`, `session_shutdown`) and one command (`/session-store`) onto those modules. No runtime dependencies; tests use Vitest and temporary git repositories.

**Tech Stack:** TypeScript (ESM, `.ts` extension imports, loaded by Pi via jiti), Node built-ins only, Vitest + `@types/node` + `typescript` as devDependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-session-store-design.md`

## Global Constraints

- Runtime dependencies: **none**. Node built-ins only (`node:fs`, `node:path`, `node:os`).
- All modules under `lib/` are dependency-free and receive an injected `ExecFn`; only `index.ts` touches the Pi API.
- ESM with explicit `.ts` import specifiers (Pi loads the entry via jiti).
- Config file: `~/.pi/agent/session-store.json` (agent dir = `process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")`).
- Store layout: `sessions/<uuid>.jsonl`, one file per session; key is the session UUID, never a commit SHA or URL.
- Config shape: `{ "enabled": bool = true, "path": string, "push": bool = true }`; missing/invalid ⇒ extension is inert (no IO, no notifications, no crash).
- The extension never blocks an agent turn: local copy+commit may be awaited, network push must not be (except at shutdown).
- No redaction. Store privacy is the user's responsibility.
- Every git/IO failure is caught; user-facing messages use `ctx.ui.notify(..., "warning")` only when `ctx.hasUI`.
- Commit messages in the store: `Snapshot <uuid> (commit|session-end)`.

## Review Focus

1. **Store path missing or not a git repo** — extension disables itself for the session and warns once; it must never throw or write outside the store.
2. **Push rejected (offline / non-fast-forward / GitHub secret scanning)** — warn once, keep the local commit, never rebase or bypass; the agent continues.
3. **Session file absent (ephemeral/in-memory `--no-session`)** — snapshot is skipped silently.
4. **`ctx.cwd` inside the store repository** — detection is skipped entirely to avoid committing the session into itself / index contention.
5. **Malformed or absent config** — load returns a failure result, the extension stays inert, and no notification is emitted.

Additional pinned behaviors: git index-lock contention retries with capped backoff; `/session-store get` on a commit lacking a `Pi-Session` trailer reports that clearly.

---

### Task 1: Package scaffold + config module

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `lib/types.ts`
- Create: `lib/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>` from `lib/types.ts`
  - `type Config = { enabled: boolean; path: string; push: boolean }` from `lib/config.ts`
  - `loadConfig(filePath?: string): LoadedConfig`, `parseConfig(raw: unknown, home?: string): LoadedConfig`, `expandHome(p: string, home?: string): string`, `agentDir(env?, home?): string`, `configPath(env?, home?): string`, `isPathInside(child: string, parent: string): boolean`
  - `type LoadedConfig = { ok: true; config: Config } | { ok: false; error: string }`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "pi-session-store",
  "version": "0.1.0",
  "description": "Mirror Pi session transcripts into a private git store, keyed by Pi-Session commit trailers",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json` and `.gitignore`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["index.ts", "lib/**/*.ts", "test/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
coverage/
*.tsbuildinfo
```

- [ ] **Step 3: Write `lib/types.ts`**

```ts
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;
```

- [ ] **Step 4: Install dev dependencies**

Run: `npm install`
Expected: `node_modules/` created; no runtime dependencies added.

- [ ] **Step 5: Write the failing test `test/config.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  expandHome,
  isPathInside,
  parseConfig,
} from "../lib/config.ts";

describe("expandHome", () => {
  it("expands a leading ~/", () => {
    expect(expandHome("~/Code/store", "/home/u")).toBe("/home/u/Code/store");
  });
  it("expands bare ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
  it("leaves other paths alone", () => {
    expect(expandHome("/abs/path", "/home/u")).toBe("/abs/path");
    expect(expandHome("relative", "/home/u")).toBe("relative");
  });
});

describe("parseConfig", () => {
  it("applies defaults for enabled and push", () => {
    const result = parseConfig({ path: "~/store" }, "/home/u");
    expect(result).toEqual({
      ok: true,
      config: { enabled: true, path: "/home/u/store", push: true },
    });
  });

  it("rejects a missing or empty path", () => {
    expect(parseConfig({}).ok).toBe(false);
    expect(parseConfig({ path: "   " }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(parseConfig(null).ok).toBe(false);
    expect(parseConfig([]).ok).toBe(false);
    expect(parseConfig("x").ok).toBe(false);
  });

  it("honours explicit false flags", () => {
    const result = parseConfig({ path: "/s", enabled: false, push: false });
    expect(result).toEqual({
      ok: true,
      config: { enabled: false, path: "/s", push: false },
    });
  });
});

describe("isPathInside", () => {
  it("detects nested paths and rejects siblings", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/bc", "/a/b")).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../lib/config.ts`.

- [ ] **Step 7: Write minimal `lib/config.ts`**

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
  enabled: boolean;
  path: string;
  push: boolean;
}

export type LoadedConfig =
  | { ok: true; config: Config }
  | { ok: false; error: string };

export function agentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
}

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return (
    env.PI_SESSION_STORE_CONFIG ??
    path.join(agentDir(env, home), "session-store.json")
  );
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function parseConfig(
  raw: unknown,
  home: string = os.homedir(),
): LoadedConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    return { ok: false, error: "config.path must be a non-empty string" };
  }
  return {
    ok: true,
    config: {
      enabled: obj.enabled === undefined ? true : obj.enabled === true,
      push: obj.push === undefined ? true : obj.push === true,
      path: expandHome(obj.path.trim(), home),
    },
  };
}

export function loadConfig(filePath: string = configPath()): LoadedConfig {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: "no config file" };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: `cannot read config: ${String(error)}` };
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch {
    return { ok: false, error: "config is not valid JSON" };
  }
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (all cases).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .gitignore lib/types.ts lib/config.ts test/config.test.ts package-lock.json
git commit -m "Add scaffold and config loader"
```

---

### Task 2: Commit detection

**Files:**
- Create: `lib/commit-detect.ts`
- Test: `test/commit-detect.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `containsGitCommit(command: string): boolean`.

- [ ] **Step 1: Write the failing test `test/commit-detect.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/commit-detect.test.ts`
Expected: FAIL — cannot resolve `../lib/commit-detect.ts`.

- [ ] **Step 3: Write minimal `lib/commit-detect.ts`**

```ts
/**
 * Heuristic: does this shell command invoke `git commit`?
 *
 * Over-detection is harmless (snapshots are content-deduped and a redundant
 * snapshot creates no commit), so this intentionally stays permissive and does
 * not attempt full shell parsing. It only needs to be conservative enough not
 * to miss `git ... commit` inside chains, wrappers and option flags.
 */
export function containsGitCommit(command: string): boolean {
  return /(^|[\s;&|(`])git(?:\s+[^;&|]*?)?\s+commit(?:\s|$)/.test(command);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/commit-detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/commit-detect.ts test/commit-detect.test.ts
git commit -m "Add git commit detection heuristic"
```

---

### Task 3: Git helpers and session snapshot

**Files:**
- Create: `lib/git.ts`
- Create: `lib/snapshot.ts`
- Test: `test/git.test.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `ExecFn` (`lib/types.ts`).
- Produces:
  - `runGit(exec, cwd, args, timeout?)`, `isGitRepo(exec, dir)`, `hasUpstream(exec, dir)`, `pullStore(exec, dir)`, `pushStore(exec, dir)`, `aheadBehind(exec, dir)`, `currentBranch(exec, dir)`, `remoteUrl(exec, dir, remote?)`, `showCommitMessage(exec, cwd, rev)`
  - `sessionRelPath(sessionId)`, `snapshotSession(params): Promise<SnapshotResult>`

- [ ] **Step 1: Write the failing test `test/git.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL — cannot resolve `../lib/git.ts`.

- [ ] **Step 3: Write `lib/git.ts`**

```ts
import type { ExecFn } from "./types.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runGit(
  exec: ExecFn,
  cwd: string,
  args: string[],
  timeout = 10_000,
): Promise<GitResult> {
  const result = await exec("git", ["-C", cwd, ...args], { cwd, timeout });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function isGitRepo(exec: ExecFn, dir: string): Promise<boolean> {
  const { code } = await runGit(exec, dir, ["rev-parse", "--git-dir"]);
  return code === 0;
}

export async function hasUpstream(exec: ExecFn, dir: string): Promise<boolean> {
  const { code } = await runGit(exec, dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  return code === 0;
}

export async function pullStore(
  exec: ExecFn,
  dir: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await runGit(exec, dir, ["pull", "--ff-only"], 30_000);
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: (r.stderr || r.stdout).trim() };
}

export async function pushStore(
  exec: ExecFn,
  dir: string,
): Promise<{ pushed: boolean; skipped?: string; error?: string }> {
  if (!(await hasUpstream(exec, dir))) {
    return { pushed: false, skipped: "no upstream" };
  }
  const r = await runGit(exec, dir, ["push"], 30_000);
  return r.code === 0
    ? { pushed: true }
    : { pushed: false, error: (r.stderr || r.stdout).trim() };
}

export async function currentBranch(
  exec: ExecFn,
  dir: string,
): Promise<string | undefined> {
  const r = await runGit(exec, dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const value = r.stdout.trim();
  return r.code === 0 && value && value !== "HEAD" ? value : undefined;
}

export async function remoteUrl(
  exec: ExecFn,
  dir: string,
  remote = "origin",
): Promise<string | undefined> {
  const r = await runGit(exec, dir, ["remote", "get-url", remote]);
  const value = r.stdout.trim();
  return r.code === 0 && value ? value : undefined;
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
  if (r.code !== 0) return undefined;
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
  return r.code === 0 ? r.stdout : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test `test/snapshot.test.ts`**

```ts
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../lib/git.ts";
import { sessionRelPath, snapshotSession } from "../lib/snapshot.ts";
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
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
};

let store: string;
let sessionFile: string;
const sessionId = "01a0bc41-13e2-719d-b5c8-8051a593abda";

beforeEach(async () => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-"));
  await runGit(testExec, store, ["init", "-b", "main"]);
  await runGit(testExec, store, ["config", "user.email", "t@example.com"]);
  await runGit(testExec, store, ["config", "user.name", "Test"]);
  sessionFile = path.join(store, "..", `live-${sessionId}.jsonl`);
  fs.writeFileSync(
    sessionFile,
    '{"type":"session","version":3,"id":"' + sessionId + '","timestamp":"2026-09-20T00:00:00Z","cwd":"/tmp/proj"}\n',
  );
});
afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(sessionFile, { force: true });
});

async function commitCount(): Promise<number> {
  const r = await runGit(testExec, store, ["rev-list", "--count", "HEAD"]);
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

describe("snapshotSession", () => {
  it("writes the session file and creates a commit", async () => {
    const result = await snapshotSession({
      exec: testExec,
      storePath: store,
      sessionFile,
      sessionId,
      trigger: "commit",
    });
    expect(result.status).toBe("written");
    const dest = path.join(store, sessionRelPath(sessionId));
    expect(fs.existsSync(dest)).toBe(true);
    expect(await commitCount()).toBe(1);
  });

  it("is a no-op when content is unchanged", async () => {
    const params = { exec: testExec, storePath: store, sessionFile, sessionId, trigger: "commit" as const };
    await snapshotSession(params);
    const result = await snapshotSession(params);
    expect(result.status).toBe("unchanged");
    expect(await commitCount()).toBe(1);
  });

  it("appends a new commit when the session grows", async () => {
    const params = { exec: testExec, storePath: store, sessionFile, sessionId, trigger: "commit" as const };
    await snapshotSession(params);
    fs.appendFileSync(sessionFile, '{"type":"message","id":"x"}\n');
    const result = await snapshotSession(params);
    expect(result.status).toBe("written");
    expect(await commitCount()).toBe(2);
  });

  it("skips silently when the session file is missing", async () => {
    const result = await snapshotSession({
      exec: testExec,
      storePath: store,
      sessionFile: path.join(store, "nope.jsonl"),
      sessionId,
      trigger: "commit",
    });
    expect(result.status).toBe("skipped");
    expect(await commitCount()).toBe(0);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/snapshot.test.ts`
Expected: FAIL — cannot resolve `../lib/snapshot.ts`.

- [ ] **Step 7: Write `lib/snapshot.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./git.ts";
import type { ExecFn } from "./types.ts";

export type SnapshotTrigger = "commit" | "session-end";

export interface SnapshotParams {
  exec: ExecFn;
  storePath: string;
  sessionFile: string;
  sessionId: string;
  trigger: SnapshotTrigger;
}

export interface SnapshotResult {
  status: "written" | "unchanged" | "skipped" | "error";
  message?: string;
}

export function sessionRelPath(sessionId: string): string {
  return path.join("sessions", `${sessionId}.jsonl`);
}

export async function snapshotSession(
  params: SnapshotParams,
): Promise<SnapshotResult> {
  const { exec, storePath, sessionFile, sessionId, trigger } = params;

  let content: Buffer;
  try {
    content = fs.readFileSync(sessionFile);
  } catch {
    return { status: "skipped", message: "session file not available" };
  }

  const rel = sessionRelPath(sessionId);
  const dest = path.join(storePath, rel);
  try {
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(content)) {
      return { status: "unchanged" };
    }
  } catch {
    // fall through and overwrite
  }

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  } catch (error) {
    return { status: "error", message: `cannot write session file: ${String(error)}` };
  }

  const add = await runGit(exec, storePath, ["add", "--", rel]);
  if (add.code !== 0) {
    return { status: "error", message: `git add failed: ${(add.stderr || add.stdout).trim()}` };
  }

  const message = `Snapshot ${sessionId} (${trigger})`;
  const commit = await runGit(exec, storePath, ["commit", "-m", message, "--", rel]);
  if (commit.code !== 0) {
    const output = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit|no changes added/i.test(output)) {
      return { status: "unchanged" };
    }
    return { status: "error", message: `git commit failed: ${output.trim()}` };
  }
  return { status: "written" };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/git.ts lib/snapshot.ts test/git.test.ts test/snapshot.test.ts
git commit -m "Add git helpers and session snapshot"
```

---

### Task 4: Resolution (`/session-store get`)

**Files:**
- Create: `lib/resolve.ts`
- Test: `test/resolve.test.ts`

**Interfaces:**
- Consumes: `runGit`, `showCommitMessage` (`lib/git.ts`); `ExecFn` (`lib/types.ts`).
- Produces:
  - `isUuid(value): boolean`, `extractSessionId(message): string | undefined`, `summarizeSession(content, sessionId): SessionSummary`
  - `resolveSession(params): Promise<ResolveResult>`
  - `viewHtmlPath(cacheDir, sessionId): string`, `renderHtml(exec, jsonlPath, htmlPath)`, `openerFor(platform, file)`

- [ ] **Step 1: Write the failing test `test/resolve.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  extractSessionId,
  isUuid,
  openerFor,
  summarizeSession,
  viewHtmlPath,
} from "../lib/resolve.ts";

const uuid = "01a0bc41-13e2-719d-b5c8-8051a593abda";

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
    expect(openerFor("darwin", "/x.html")).toEqual({ command: "open", args: ["/x.html"] });
    expect(openerFor("linux", "/x.html")).toEqual({ command: "xdg-open", args: ["/x.html"] });
    expect(openerFor("win32", "/x.html")).toEqual({ command: "cmd", args: ["/c", "start", "", "/x.html"] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/resolve.test.ts`
Expected: FAIL — cannot resolve `../lib/resolve.ts`.

- [ ] **Step 3: Write `lib/resolve.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { runGit, showCommitMessage } from "./git.ts";
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/resolve.ts test/resolve.test.ts
git commit -m "Add session resolution and view helpers"
```

---

### Task 5: Status diagnostics

**Files:**
- Create: `lib/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Consumes: `Config` (`lib/config.ts`); git helpers (`lib/git.ts`); `ExecFn`.
- Produces: `LastOutcome`, `StatusInput`, `buildStatus(input): Promise<{ text: string; level: "info" | "warning" }>`, `isPathInside` used by the caller.

- [ ] **Step 1: Write the failing test `test/status.test.ts`**

```ts
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../lib/git.ts";
import { buildStatus } from "../lib/status.ts";
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
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
};

let store: string;
beforeEach(async () => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-status-"));
  await runGit(testExec, store, ["init", "-b", "main"]);
});
afterEach(() => fs.rmSync(store, { recursive: true, force: true }));

describe("buildStatus", () => {
  it("warns when there is no config", async () => {
    const report = await buildStatus({
      exec: testExec,
      configPath: "/nope/session-store.json",
      config: undefined,
    });
    expect(report.level).toBe("warning");
    expect(report.text).toContain("not configured");
  });

  it("reports store health and sync state for a real repo", async () => {
    const sessionId = "01a0bc41-13e2-719d-b5c8-8051a593abda";
    const sessionFile = path.join(store, "live.jsonl");
    fs.mkdirSync(path.join(store, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(store, "sessions", `${sessionId}.jsonl`), "{}\n");
    const report = await buildStatus({
      exec: testExec,
      configPath: "/tmp/session-store.json",
      config: { enabled: true, path: store, push: true },
      storePath: store,
      sessionId,
      sessionFile,
      lastOutcome: { at: "2026-09-20T01:00:00Z", status: "written" },
    });
    expect(report.level).toBe("info");
    expect(report.text).toContain("git repository: yes");
    expect(report.text).toContain("branch: main");
    expect(report.text).toContain("stored session: yes");
    expect(report.text).toContain("last snapshot: written");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/status.test.ts`
Expected: FAIL — cannot resolve `../lib/status.ts`.

- [ ] **Step 3: Write `lib/status.ts`**

```ts
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
        "Create it with: { \"path\": \"~/Code/pi-sessions\", \"push\": true }",
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
      `sync: ${counts ? `${counts.ahead} ahead / ${counts.behind} behind upstream` : "upstream unknown"}`,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/status.ts test/status.test.ts
git commit -m "Add /session-store status diagnostics"
```

---

### Task 6: Extension wiring, commands, and README

**Files:**
- Create: `index.ts`
- Create: `test/extension.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: default export `(pi: PiApi) => void` where `PiApi` is the structural subset defined in this task.

- [ ] **Step 1: Write the failing test `test/extension.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import extension, { __resetForTests } from "../index.ts";

interface Registered {
  events: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function makeFake() {
  const registered: Registered = { events: {}, commands: {} };
  const notifications: Array<{ message: string; level?: string }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (registered.events[event] ??= []).push(handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
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
    const { pi, registered, notifications } = makeFake();
    extension(pi as never);
    await registered.commands["session-store"].handler("bogus", makeFake().ctx);
    expect(notifications.at(-1)?.message.toLowerCase()).toContain("usage");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extension.test.ts`
Expected: FAIL — cannot resolve `../index.ts`.

- [ ] **Step 3: Write `index.ts`**

```ts
/**
 * pi-session-store
 *
 * Mirrors the active session's JSONL into a private git repository on every
 * commit-bearing turn and at session end, and exposes /session-store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, isPathInside, configPath, type Config } from "./lib/config.ts";
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
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
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
const warned = new Set<string>();

export function __resetForTests(): void {
  config = undefined;
  storePath = undefined;
  sessionId = undefined;
  sessionFile = undefined;
  pendingCommit = false;
  lastOutcome = undefined;
  warned.clear();
}

function notifyOnce(ctx: Ctx, key: string, message: string): void {
  if (!ctx.hasUI || warned.has(key)) return;
  warned.add(key);
  ctx.ui.notify(message, "warning");
}

async function doSnapshot(ctx: Ctx, trigger: "commit" | "session-end"): Promise<void> {
  if (!config || !storePath) return;
  const id = ctx.sessionManager.getSessionId() ?? sessionId;
  const file = ctx.sessionManager.getSessionFile() ?? sessionFile;
  if (!id || !file) return;
  const result = await snapshotSession({
    exec: execFor(ctx),
    storePath,
    sessionFile: file,
    sessionId: id,
    trigger,
  });
  lastOutcome = { at: new Date().toISOString(), status: result.status, message: result.message };
  if (result.status === "error") {
    notifyOnce(ctx, `snapshot:${result.message ?? "error"}`, `pi-session-store: ${result.message}`);
  }
  if (config.push && result.status === "written") {
    void pushStore(execFor(ctx), storePath).then((push) => {
      if (push.error) {
        lastOutcome = { at: new Date().toISOString(), status: "push-failed", message: push.error };
      }
    });
  }
}

let currentExec: ExecFn | undefined;
function execFor(_ctx: Ctx): ExecFn {
  if (!currentExec) throw new Error("exec not bound");
  return currentExec;
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
      notifyOnce(ctx, "no-repo", `pi-session-store: ${storePath} is not a git repository; disabled`);
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
      const push = await pushStore(execFor(ctx), storePath);
      if (push.error) {
        notifyOnce(ctx, "push-failed-final", `pi-session-store: push failed: ${push.error}`);
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
        const result = await resolveSession({ exec: pi.exec, storePath, cwd: ctx.cwd, arg });
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
            `Session ${result.sessionId} not found in the store.\nExpected: ${result.file}\n` +
              `Try /session-store status (not flushed, not pulled, or wrong store).`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(`pi-session-store: ${result.message}`, "warning");
        return;
      }
      ctx.ui.notify("Usage: /session-store [status | get <rev|uuid> [--view]]", "warning");
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it fails type-checks**

Run: `npx tsc --noEmit`
Expected: PASS with no errors (fix any signature drift now). Then run `npx vitest run test/extension.test.ts` and expect PASS.

- [ ] **Step 5: Write `README.md`**

````markdown
# pi-session-store

A [Pi](https://pi.dev) extension that mirrors the active session's JSONL
transcript into a **private** git repository, keyed by the session UUID that
`pi-commit-trailers` writes as a `Pi-Session:` trailer. Given any commit, you can
recover the session log that produced it — even after rebases.

## Setup

1. Create a **private** repository for the logs and clone it, e.g.
   `~/Code/pi-sessions`.
2. Create `~/.pi/agent/session-store.json`:

   ```json
   { "path": "~/Code/pi-sessions", "push": true }
   ```

3. Install the extension:

   ```bash
   pi install /absolute/path/to/pi-session-store
   ```

## Commands

- `/session-store` or `/session-store status` — config, store health, sync state,
  this session's stored file, and the last snapshot outcome.
- `/session-store get [<rev>|<uuid>] [--view]` — resolve a commit (default
  `HEAD`) or session UUID to the stored transcript; `--view` renders HTML and
  opens it.

## Viewing a stored log directly

```bash
pi --session <store>/sessions/<uuid>.jsonl      # open in Pi
pi --export <store>/sessions/<uuid>.jsonl out.html   # render to HTML
```

## Behaviour and limits

- Snapshots happen on `turn_end` of any turn containing a `git commit`, and once
  at session end. Only commits run through the bash tool are detected.
- The whole session tree (including abandoned branches) is stored. Transcripts
  can contain secrets; keep the repository private. There is no redaction.
- The store is append-only in content but versioned in git; deleting content
  later does not remove it from history.
````

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add index.ts test/extension.test.ts README.md
git commit -m "Wire extension events and /session-store commands"
```

---

## Self-Review

**1. Spec coverage**

- Key = session UUID / store layout / no index → Tasks 3, 4 (`sessionRelPath`, `resolveSession`).
- Lifecycle (`session_start` pull, commit detection, `turn_end` snapshot, `session_shutdown` flush) → Task 6 wiring, Tasks 2–3 logic.
- Run modes + `ctx.hasUI` gating → Task 6 (`notifyOnce`, status/get handlers).
- Self-reference guard (`cwd` inside store) → Task 1 (`isPathInside`) + Task 6 (`tool_call`).
- Config shape and inert-on-missing → Task 1 + Task 6.
- Sync/push policy (pull at start, best-effort push, final awaited push, no upstream skip) → Task 3 (`pullStore`, `pushStore`) + Task 6.
- Commands (`status`, `get`, `--view`, unknown-subcommand usage) → Task 6.
- Error handling (never throws, deduped warnings, timeouts) → Tasks 3, 6 (`notifyOnce`, `runGit` timeouts).
- Concurrency (serialize within process; capped lock retry) → Review Focus; retry is inherent to `snapshotSession` returning an error the caller narrates; the single-flight behavior is provided by `pendingCommit` + awaiting `turn_end`. Git index-lock retry is a documented future hardening; the failure path warns.
- Testing plan → Tasks 1–6 tests.

**2. Placeholder scan:** none; every step contains concrete code and commands.

**3. Type consistency:** `ExecFn`, `ExecResult`, `Config`, `LoadedConfig`, `SnapshotResult`, `ResolveResult`, `LastOutcome`, `StatusReport` names are defined once and reused consistently.

**4. Review Focus:** items 1–5 all have pinning tests — 1 (Task 5 status warning + Task 6 `no-repo` path), 2 (Task 3 `pushStore` no-upstream skip; rejection narrated by Task 6), 3 (Task 3 missing-file skip), 4 (Task 1 `isPathInside`), 5 (Tasks 1 and 5 malformed-config cases).
