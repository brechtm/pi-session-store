# pi-session-store — Design

## Summary

A Pi extension that mirrors the active Pi session's JSONL transcript into a
private git repository, keyed by session UUID. Snapshots are taken whenever the
agent makes a commit and once when the session ends. A small `/session-log`
command resolves a commit's `Pi-Session:` trailer back to the stored log, and can
render/open it as HTML.

## Motivation

Commits produced by the agent carry a `Pi-Session: <uuid>` trailer (written by the
`pi-commit-trailers` extension). Given such a commit, there is currently no
durable, private, machine-independent place to retrieve the corresponding session
log. GitHub gists are URL-addressed, effectively public-to-anyone-with-the-link,
tied to an account, and produce dead links over time. A commit is immutable, so
baking a URL into it is fragile.

The fix is to keep commits referencing only a stable identifier (the session
UUID, which survives rebases) and to store the logs somewhere private and
retrievable, resolving the identifier through configurable tooling.

## Audience and Success Criteria

Single user, across their own machines. No multi-user or public access.

Success means:

- After an agent commit, the session transcript is committed (and pushed) to the
  configured private store repository.
- `Pi-Session: <uuid>` in any surviving commit resolves to a stored log via
  `/session-log <rev>`, regardless of rebases.
- Nothing is stored or uploaded anywhere unless the user has explicitly
  configured a store repository.
- Every git or IO failure is contained: it never blocks, corrupts, or aborts the
  agent turn.

## Non-Goals

- Redaction or secret scanning of transcripts.
- Public or per-session shareable visibility.
- Keying storage on commit SHAs (rebases invalidate them).
- Auto-creating or cloning the store repository (an existing clone is required).
- An LLM-callable tool that returns transcript content (context-safety); the
  command surface is text + optional browser view.
- Recording authoritative provenance (the triggering commit's subject/hash) in
  store commits; store commits identify only the session and the trigger.
- Detecting or overriding a public store remote; keeping the store private is
  documented, not enforced.

## Assumptions and Dependencies

- `pi-commit-trailers` (or equivalent) writes `Pi-Session: <uuid>` into commit
  messages. Without it the store still receives snapshots, but commits cannot be
  resolved to logs.
- The store repository is private and, for a given session, written by exactly one
  machine at a time.
- Pi extension API used: `pi.on(...)`, `pi.registerCommand(...)`,
  `pi.exec(command, args, { cwd, timeout })`, `getAgentDir()`, and
  `ctx.sessionManager` (`getSessionId()`, `getSessionFile()`), plus
  `ctx.ui.notify(...)` and `ctx.cwd`.
- Session entries are persisted synchronously to the JSONL file as they occur, so
  the file's contents at `turn_end` include the commit's tool call and result.

## Data Model

- **Canonical key:** the Pi session UUID (`ctx.sessionManager.getSessionId()`),
  which is also what appears in the commit trailer. Never the commit SHA, and
  never a URL.
- **Store:** an existing git working copy at a configured filesystem path.
- **Layout:** one file per session, `sessions/<uuid>.jsonl`. Flat and
  deterministic, so resolution requires no index.
- **Store commit message:** identifies the session UUID and whether the snapshot
  was triggered by a commit or by session end. It carries no commit subject/hash;
  authoritative provenance is deferred (see Future).

## Lifecycle

The extension runs in all Pi run modes (TUI, RPC, print, JSON). Snapshots happen
in every mode; user-facing notifications are emitted only when `ctx.hasUI` is
true, so JSON/print output is never polluted.

1. **`session_start`**
   - Load and validate config. No config ⇒ the extension is completely inert for
     the session (no filesystem or network access, no notifications).
   - Verify the configured path is a git repository (`git rev-parse --git-dir`). If
     not, warn once and disable for the session.
   - Best-effort `git pull --ff-only` to pick up sessions written elsewhere.
2. **Commit detection**
   - On every bash `tool_call`, test whether the command heuristically contains a
     `git commit` invocation. If so, raise a per-session "commit happened" flag.
   - The test only needs a boolean: over-detection is harmless because snapshots
     are content-deduped and a redundant snapshot produces no commit.
   - Skip detection entirely when `ctx.cwd` resolves inside the store repository:
     snapshotting the store into itself risks index contention and commits the
     session into the wrong repo.
3. **`turn_end` with the flag set**
   - Perform a snapshot (below), then clear the flag.
   - Snapshot at `turn_end` rather than at `tool_result` because the session JSONL
     is appended synchronously per entry and a turn boundary guarantees the
     commit's tool call *and* result are on disk.
   - Multiple commits within one turn or one command collapse into one snapshot.
4. **Snapshot**
   1. Resolve the session file; skip if absent (e.g. in-memory session).
   2. Compare bytes with `sessions/<uuid>.jsonl`; skip if identical.
   3. Write the file into the store.
   4. `git add` + `git commit` with a message identifying the session UUID and
      the trigger (commit or session end).
   5. Push (below), if enabled.
   - Snapshots are serialized within the process. Across processes (two Pi
     sessions sharing one store), git index-lock failures are retried with
     capped exponential backoff before warning.
5. **`session_shutdown`**
   - Final snapshot (await the copy and local commit) and a final awaited push
     attempt, with a timeout, so the tail after the last commit and any
     commit-less session is preserved.
   - A crash can skip this flush; the per-commit snapshots bound the loss to the
     work done since the last commit.

## Configuration

A dedicated JSON file in the Pi agent directory:
`~/.pi/agent/session-store.json` (resolved via `getAgentDir()`).

```json
{
  "enabled": true,
  "path": "~/Code/pi-sessions",
  "push": true
}
```

- `path` (required) — filesystem path of the existing store clone; `~` expanded.
- `push` (default `true`) — whether to push after committing. Push is attempted
  only when the current branch has an upstream remote; with no remote it is
  skipped silently (there is nothing to push).
- `enabled` (default `true`) — master switch.

Missing, unreadable, or unrecognized config ⇒ inert. There is no CLI flag in v1.

## Sync and Push

- `git pull --ff-only` at session start only.
- Every snapshot commits locally (fast, cannot fail due to network).
- Push is best-effort and fired without blocking the turn; a final push is awaited
  at `session_shutdown`.
- A rejected push (non-fast-forward, from another machine) warns once and is left
  for manual resolution; the extension never rebases mid-session.

## Resolver: `/session-log`

Usage: `/session-log [<rev>|<uuid>]` (default `HEAD`). The name avoids the core
`/session` command.

- A UUID-shaped argument (36 chars, hex + hyphens) is used directly; anything
  else is treated as a git rev. Resolution reads the local clone only; it does
  not fetch (the session-start pull keeps it current).
- Rev path: `git -C <ctx.cwd> show -s --format=%B <rev>`, then parse the
  `Pi-Session:` trailer. No trailer ⇒ clear message.
- Lookup: `sessions/<uuid>.jsonl` in the configured store.
- Output: the UUID, the store file path, and a compact summary (session working
  directory, start time, entry count). It does not dump transcript content.
- Not found: explain the likely cause (no trailer, session never flushed, not
  pulled, wrong store). If the UUID is the *current live* session and has not been
  flushed yet, point to the live session file instead.
- `--view` flag: export the stored JSONL to HTML via
  `pi --export <path> <cache>/<uuid>.html` and open it with the platform opener
  (`open` / `xdg-open` / `start`). Rendering adds no new dependency and matches
  the built-in `/export` output.
- No config or no store ⇒ clear error message, never a crash.

## Viewing Stored Logs (documentation)

- Interactive: `pi --session <path>` or `/import <path>`.
- HTML: `pi --export <path> [out.html]`, then open the file; `/session-log --view`
  wraps this.

## Error Handling

- Handlers never throw; everything is caught.
- Actionable failures surface as non-blocking `ctx.ui.notify(..., "warning")`
  when `ctx.hasUI`, de-duplicated per session so a broken remote cannot spam.
- Local copy + commit are awaited (fast); network push is not, except at
  shutdown.
- All `pi.exec` calls carry a timeout.
- Explicit cases: missing session file; store missing or not a repo; git
  index-lock contention (retry with capped backoff, then warn); push rejected;
  config parse failure.
- A push rejected by GitHub secret scanning is treated like any other push
  failure: warn once, keep the local commit, and never attempt to bypass the
  protection.

## Project Layout

```
~/Code/pi-session-store/
  package.json            # name, "pi-package" keyword, pi.extensions manifest
  index.ts                # extension wiring: events + /session-log command
  lib/config.ts           # load/validate config, ~ expansion
  lib/commit-detect.ts    # bash command -> "contains a git commit"
  lib/git.ts              # thin git wrappers over an injected exec function
  lib/snapshot.ts         # compare/write/commit/push a session snapshot
  lib/resolve.ts          # trailer parsing, lookup, summary, HTML view
  test/*.test.ts          # unit + integration tests
  README.md
  docs/superpowers/specs/2026-09-20-pi-session-store-design.md
  docs/superpowers/plans/<plan>.md
```

- TypeScript, loaded directly by Pi via jiti; no build step.
- Installed for use with `pi install /absolute/path/to/pi-session-store` (local
  path, no copy) or `pi -e /absolute/path/...` during development.
- Core modules take an injected `exec` function so they are testable without a
  live Pi.

## Testing

- **Unit:** config loading and `~` expansion; UUID detection; `Pi-Session`
  trailer parsing; commit detection; summary extraction; content-change
  detection.
- **Integration (temporary git repo as the store):** snapshot writes
  `sessions/<uuid>.jsonl` and creates a commit; unchanged content is a no-op; a
  subsequent snapshot appends a new commit; push works against a local bare
  remote; `/session-log` resolution finds the file.
- **Smoke:** run with `pi -e`, make a real agent commit, confirm the store updated
  and `/session-log` resolves.

## Security and Privacy

- The extension never changes a repository's visibility; keeping the store private
  is the user's responsibility and is documented in the README.
- A public store remote is not detected or blocked; the user must confirm the
  store remote is private.
- GitHub secret scanning may reject a push; the extension does not attempt to
  bypass it.
- Transcripts may contain secrets or sensitive work. Once committed they persist
  in git history even if later deleted; the store is assumed private and
  single-user.
- No redaction in v1.

## Future / Open Questions

- `/session-store status` diagnostic command (config, store health, sync state,
  last snapshot outcome).
- Caching location and lifetime for `--view` output.
- Optional git-notes provenance attached to code commits.
- Optional redaction/secret scanning before committing a snapshot.
- Append-only delta copy instead of a full byte comparison per snapshot.
- Compaction/LFS for large transcripts; retention and deletion.
- A one-time `init` helper (`gh repo create` + clone + config).
