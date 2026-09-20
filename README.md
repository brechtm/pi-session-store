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
pi --session <store>/sessions/<uuid>.jsonl            # open in Pi
pi --export <store>/sessions/<uuid>.jsonl out.html    # render to HTML
```

## Behaviour and limits

- Snapshots happen on `turn_end` of any turn containing a `git commit`, and once
  at session end. Only commits run through the bash tool are detected.
- The whole session tree (including abandoned branches) is stored. Transcripts
  can contain secrets; keep the repository private. There is no redaction.
- The store is append-only in content but versioned in git; deleting content
  later does not remove it from history.
- If the configured store is missing or is not a git repository, the extension
  disables itself for the session and warns once.
