/**
 * Heuristic: does this shell command invoke `git commit`?
 *
 * Over-detection is harmless (snapshots are content-deduped and a redundant
 * snapshot creates no commit), so this intentionally stays permissive and does
 * not attempt full shell parsing. It only needs to be conservative enough not
 * to miss `git ... commit` inside chains, wrappers and option flags.
 */
export function containsGitCommit(command: string): boolean {
  return /(^|[\s;&|(`])git(?:\s+[^;&|]*?)?\s+commit(?![\w-])/.test(command);
}
