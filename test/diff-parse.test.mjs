/** Host-side parsing: hunk headers, pairing rules, and untracked detection. */
import { assert, test } from './harness.mjs'
import { parseDiff, isUntracked, buildLineInfo } from '../src/diff-parse.mjs'

/** One modified line, one whole-line deletion, one added line. */
const SAMPLE_DIFF = [
  'diff --git a/note.md b/note.md',
  'index 1111111..2222222 100644',
  '--- a/note.md',
  '+++ b/note.md',
  '@@ -1 +1 @@',
  '-keep this old',
  '+keep this new',
  '@@ -3,2 +3,0 @@',
  '-gone line one',
  '-gone line two',
  '@@ -8,0 +7 @@',
  '+brand new line',
  '',
].join('\n')

test('parseDiff pairs a -/+ couple into one modified current line', () => {
  const { lines } = parseDiff(SAMPLE_DIFF)
  const modified = lines.filter(entry => entry.kind === 'modified')
  assert.equal(modified.length, 1)
  assert.deepEqual(modified[0], { line: 1, kind: 'modified', oldText: 'keep this old', newText: 'keep this new' })
})

test('parseDiff reports unpaired - lines as whole-line deletions before their anchor', () => {
  const { deletions } = parseDiff(SAMPLE_DIFF)
  assert.deepEqual(deletions, [
    { line: 3, text: 'gone line one' },
    { line: 3, text: 'gone line two' },
  ])
})

test('parseDiff reports an unpaired + line as added at its current line number', () => {
  const { lines } = parseDiff(SAMPLE_DIFF)
  const added = lines.filter(entry => entry.kind === 'added')
  assert.deepEqual(added, [{ line: 7, kind: 'added', newText: 'brand new line' }])
})

test('parseDiff ignores diff headers, No-newline markers, and empty input', () => {
  assert.deepEqual(parseDiff(''), { lines: [], deletions: [] })
  assert.deepEqual(parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n'), { lines: [], deletions: [] })
  const withMarker = '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'
  assert.deepEqual(parseDiff(withMarker).lines, [{ line: 1, kind: 'modified', oldText: 'a', newText: 'b' }])
})

test('parseDiff keeps a pure deletion hunk anchored at the following current line', () => {
  const diff = '@@ -1,2 +0,0 @@\n-first\n-second\n'
  assert.deepEqual(parseDiff(diff), { lines: [], deletions: [{ line: 0, text: 'first' }, { line: 0, text: 'second' }] })
})

test('isUntracked recognises porcelain ?? lines only', () => {
  assert.equal(isUntracked('?? note.md\n'), true)
  assert.equal(isUntracked('\n?? dir/note.md\n'), true)
  assert.equal(isUntracked(' M note.md\n'), false)
  assert.equal(isUntracked('A  note.md\n'), false)
  assert.equal(isUntracked(''), false)
})

test('buildLineInfo marks an untracked file without parsing a diff', () => {
  const info = buildLineInfo({ headOid: 'abc', diffText: '', statusText: '?? note.md\n' })
  assert.deepEqual(info, { version: 'abc', lines: [], deletions: [], untracked: true })
})

test('buildLineInfo falls back to no-head when the repository has no commit', () => {
  const info = buildLineInfo({ headOid: undefined, diffText: '', statusText: 'A  note.md\n' })
  assert.equal(info.version, 'no-head')
  assert.equal(info.untracked, false)
})
