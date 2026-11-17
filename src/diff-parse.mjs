/**
 * dsh-git-mark host: pure parsing of `git diff HEAD --unified=0` and
 * `git status --porcelain` output into per-current-line change facts.
 *
 * This module is plain ESM with no runtime imports so the Node host half and
 * the unit tests share one implementation.
 *
 * Response shape produced by `buildLineInfo`:
 * {
 *   version: string,            // HEAD oid, or "no-head" when there is no commit yet
 *   lines: [                    // only changed current-file lines, in order
 *     { line: number, kind: 'modified' | 'added', oldText?: string, newText: string }
 *   ],
 *   deletions: [                // whole old lines removed, in file order
 *     { line: number, text: string }  // line = 1-based CURRENT line the deletion precedes
 *   ],
 *   untracked: boolean,         // true for `??` (whole file marked green client-side)
 * }
 */

/** One `@@ -a,b +c,d @@` hunk header. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse `git diff --no-color --no-ext-diff --unified=0` output for one file.
 * A `-` line paired with a following `+` line (by order) is a modified
 * current line (characters are merged client-side); an unpaired `-` line is a
 * whole-line deletion; an unpaired `+` line is an added current line.
 * @param diffText - raw diff output for the addressed file.
 * @returns current-line change facts for that file.
 */
export function parseDiff(diffText) {
  /** Changed current lines, by 1-based new line number. */
  const lines = []
  /** Whole-line deletions, each placed before the current line it precedes. */
  const deletions = []
  // Deleted old lines waiting for a `+` partner inside one hunk.
  let pending = []
  let inHunk = false
  let newLine = 0

  const flushPending = () => {
    for (const text of pending) deletions.push({ line: newLine, text })
    pending = []
  }

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) {
      const match = HUNK.exec(raw)
      if (match !== null) {
        flushPending()
        newLine = Number(match[3])
        inHunk = true
      }
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('\\')) continue // "No newline at end of file" marker
    if (raw.startsWith('-')) {
      pending.push(raw.slice(1))
    } else if (raw.startsWith('+')) {
      const newText = raw.slice(1)
      const oldText = pending.shift()
      if (oldText === undefined) {
        lines.push({ line: newLine, kind: 'added', newText })
      } else {
        lines.push({ line: newLine, kind: 'modified', oldText, newText })
      }
      newLine += 1
    } else if (raw.startsWith(' ')) {
      // Minimal context line between changes (only present with smaller -U).
      flushPending()
      newLine += 1
    }
    // Anything else (`--- a/…`, `+++ b/…`, headers) is ignored.
  }
  flushPending()
  return { lines, deletions }
}

/** Whether `git status --porcelain` output marks the addressed file untracked. */
export function isUntracked(statusText) {
  const first = statusText.split('\n').find(line => line.trim() !== '')
  return first !== undefined && /^\?\?/.test(first)
}

/**
 * Assemble the complete mark payload for one file.
 * @param params - HEAD oid and parsed per-file facts.
 * @returns the response a client consumes.
 */
export function buildLineInfo(params) {
  const { headOid, diffText, statusText } = params
  const untracked = isUntracked(statusText)
  if (untracked) {
    // A new file has no diff; the client marks every line green.
    return { version: headOid ?? 'no-head', lines: [], deletions: [], untracked: true }
  }
  const { lines, deletions } = parseDiff(diffText)
  return {
    version: headOid ?? 'no-head',
    lines,
    // A deleted blank line has nothing to replay in red.
    deletions: deletions.filter(entry => entry.text.trim() !== ''),
    untracked: false,
  }
}
