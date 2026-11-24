/** Client-side marking: character merge, added lines, deletions, fences, untracked. */
import { assert, test } from './harness.mjs'
import {
  mergeOldNew, injectMarkdown, injectMarkdownHtml, isBlockLine, isFenceLine, parseFileAddress, gitMarkFileAddress, markdownImageUrl,
  isTableLine, isDelimiterRow, markTableRow, mergeTableRow, isMarkedCopyPath,
} from '../src/client/inject.mjs'

/**
 * Build one host payload for a file with no untracked flag.
 * @param lines - changed current lines.
 * @param deletions - whole deleted lines.
 * @returns the payload shape lib/index.js returns.
 */
function payload(lines = [], deletions = []) {
  return { kind: 'text', version: 'v1', lines, deletions, untracked: false }
}

test('mergeOldNew marks a replaced run red then green', () => {
  assert.equal(mergeOldNew('keep this old', 'keep this new'), 'keep this ~~old~~*new*')
})

test('isMarkedCopyPath recognises the mirror tree and nothing else', () => {
  assert.equal(isMarkedCopyPath('.dsh/git-mark/docs/note.md'), true)
  assert.equal(isMarkedCopyPath('.dsh/git-mark/docs/指南.md'), true)
  assert.equal(isMarkedCopyPath('docs/note.md'), false)
  assert.equal(isMarkedCopyPath('.dsh/git-markers/x.md'), false)
  assert.equal(isMarkedCopyPath('a/.dsh/git-mark.md'), false)
  assert.equal(isMarkedCopyPath('docs/.dsh/git-mark/note.md'), true)
  assert.equal(isMarkedCopyPath(undefined), false)
  assert.equal(isMarkedCopyPath(''), false)
})

test('mergeOldNew marks Chinese per character', () => {
  assert.equal(mergeOldNew('今天天气很好', '今天天气很差'), '今天天气很~~好~~*差*')
})

test('mergeOldNew marks a pure insertion without deleting anything', () => {
  assert.equal(mergeOldNew('abcdef', 'abcXdef'), 'abc*X*def')
})

test('mergeOldNew returns identical lines untouched', () => {
  assert.equal(mergeOldNew('same text', 'same text'), 'same text')
})

test('injectMarkdownHtml wraps one added line in a data-gm span', () => {
  const text = 'alpha\nfresh line\n'
  const marked = injectMarkdownHtml(text, payload([{ line: 2, kind: 'added', newText: 'fresh line' }]))
  assert.equal(marked, 'alpha\n&#60;span data-gm="add"&#62;fresh line&#60;/span&#62;\n')
})

test('injectMarkdownHtml merges a replacement as del next to add elements', () => {
  const text = 'keep this old\n'
  const marked = injectMarkdownHtml(text, payload([
    { line: 1, kind: 'modified', oldText: 'keep this old', newText: 'keep this new' },
  ]))
  assert.equal(marked, 'keep this &#60;del data-gm="del"&#62;old&#60;/del&#62;&#60;span data-gm="add"&#62;new&#60;/span&#62;\n')
})

test('injectMarkdownHtml escapes marked content so it cannot smuggle markup', () => {
  const text = 'A < B\n'
  const marked = injectMarkdownHtml(text, payload([{ line: 1, kind: 'added', newText: 'A < B' }]))
  assert.equal(marked, '&#60;span data-gm="add"&#62;A &lt; B&#60;/span&#62;\n')
})

test('injectMarkdownHtml replays a whole deleted line as a del paragraph', () => {
  const text = 'alpha\n\nbeta\n'
  const marked = injectMarkdownHtml(text, payload([], [{ line: 3, text: 'removed <line>' }]))
  assert.equal(marked, 'alpha\n\n&#60;del data-gm="del"&#62;removed &lt;line&gt;&#60;/del&#62;\n\nbeta\n')
})

test('injectMarkdownHtml keeps fenced and structural content untouched', () => {
  const text = '```\nconst a = 1\n```\n## Heading\n'
  const marked = injectMarkdownHtml(text, payload([
    { line: 2, kind: 'modified', oldText: 'const a = 1', newText: 'const a = 2' },
    { line: 4, kind: 'added', newText: '## Heading' },
  ]))
  assert.equal(marked, text)
})

test('injectMarkdownHtml marks every non-structural line of an untracked file', () => {
  const text = 'alpha\n\n# heading\nbeta\n'
  const marked = injectMarkdownHtml(text, { kind: 'text', version: 'v1', lines: [], deletions: [], untracked: true })
  assert.equal(marked, '&#60;span data-gm="add"&#62;alpha&#60;/span&#62;\n\n# heading\n&#60;span data-gm="add"&#62;beta&#60;/span&#62;\n')
})

test('mergeOldNew degrades to whole-line markers for very long lines', () => {
  const long = 'x'.repeat(3000)
  assert.equal(mergeOldNew(long, `${long}y`), `~~${long}~~*${long}y*`)
})

test('injectMarkdown leaves text alone when there is no git data', () => {
  const text = '# title\n\nbody\n'
  assert.equal(injectMarkdown(text, null), text)
  assert.equal(injectMarkdown(text, { kind: 'not-git' }), text)
  assert.equal(injectMarkdown(text, { kind: 'no-git' }), text)
})

test('injectMarkdown marks one modified line and leaves others untouched', () => {
  const text = 'keep this old\nuntouched tail\n'
  const marked = injectMarkdown(text, payload([
    { line: 1, kind: 'modified', oldText: 'keep this old', newText: 'keep this new' },
  ]))
  assert.equal(marked, 'keep this ~~old~~*new*\nuntouched tail\n')
})

test('injectMarkdown wraps a whole added line green', () => {
  const text = 'alpha\nfresh line\n'
  const marked = injectMarkdown(text, payload([{ line: 2, kind: 'added', newText: 'fresh line' }]))
  assert.equal(marked, 'alpha\n*fresh line*\n')
})

test('injectMarkdown leaves structural added lines unmarked', () => {
  const text = 'alpha\n## Heading\n'
  const marked = injectMarkdown(text, payload([{ line: 2, kind: 'added', newText: '## Heading' }]))
  assert.equal(marked, 'alpha\n## Heading\n')
})

test('injectMarkdown never marks anything inside a code fence', () => {
  const text = 'intro\n```js\nconst a = 1\n```\noutro\n'
  const marked = injectMarkdown(text, payload([
    { line: 3, kind: 'modified', oldText: 'const a = 1', newText: 'const a = 2' },
    { line: 2, kind: 'added', newText: '```js' },
  ]))
  assert.equal(marked, text)
})

test('injectMarkdown replays a whole deleted line at a blank-line boundary', () => {
  const text = 'alpha\n\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 3, text: 'removed line' }]))
  assert.equal(marked, 'alpha\n\n~~removed line~~\n\nbeta\n')
})

test('injectMarkdown treats a blank anchor line as a safe boundary', () => {
  const text = 'alpha\n\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 2, text: 'gone' }]))
  assert.equal(marked, 'alpha\n\n~~gone~~\n\nbeta\n')
})

test('injectMarkdown drops a whole deleted line without a safe boundary', () => {
  const text = 'alpha\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 2, text: 'gone' }]))
  assert.equal(marked, text)
})

test('injectMarkdown replays a deletion that falls past the last line', () => {
  const text = 'alpha\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 9, text: 'gone' }]))
  assert.equal(marked, 'alpha\nbeta\n\n~~gone~~')
})

test('injectMarkdown folds a deletion anchored before line 1 onto the top', () => {
  const text = 'alpha\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 0, text: 'gone' }]))
  assert.equal(marked, '~~gone~~\n\nalpha\nbeta\n')
})

test('injectMarkdown ignores a deleted blank line', () => {
  const text = 'alpha\n\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 2, text: '' }, { line: 2, text: '   ' }]))
  assert.equal(marked, text)
})

test('injectMarkdown marks every non-structural line of an untracked file', () => {
  const text = 'alpha\n\n# heading\nbeta\n'
  const marked = injectMarkdown(text, { kind: 'text', version: 'v1', lines: [], deletions: [], untracked: true })
  assert.equal(marked, '*alpha*\n\n# heading\n*beta*\n')
})

test('isTableLine recognises lines that start with a pipe', () => {
  assert.equal(isTableLine('| a | b |'), true)
  assert.equal(isTableLine('|a|'), true)
  assert.equal(isTableLine(' a | b'), false)
  assert.equal(isTableLine('text'), false)
  assert.equal(isTableLine(''), false)
})

test('isDelimiterRow recognises GFM delimiter rows only', () => {
  for (const line of ['| --- | --- |', '|:---|:---:|', '|---|', '| - | :--: |', '| --- ']) {
    assert.equal(isDelimiterRow(line), true, line)
  }
  for (const line of ['| a | b |', '| --- | --- | c |', '| 1 | - |']) {
    assert.equal(isDelimiterRow(line), false, line)
  }
})

test('markTableRow wraps each added segment, keeping pipes literal', () => {
  assert.equal(markTableRow('| A | B |', 'md', 'add'), '|*A*|*B*|')
  assert.equal(markTableRow('| A |  | B |', 'md', 'add'), '|*A*||*B*|')
  assert.equal(markTableRow('| x | y', 'md', 'add'), '|*x*|*y*')
})

test('markTableRow wraps each deleted segment, keeping pipes literal', () => {
  assert.equal(markTableRow('| A | B |', 'md', 'del'), '|~~A~~|~~B~~|')
})

test('injectMarkdown marks an added table row per segment', () => {
  const text = 'alpha\n| A | B |\n'
  const marked = injectMarkdown(text, payload([{ line: 2, kind: 'added', newText: '| A | B |' }]))
  assert.equal(marked, 'alpha\n|*A*|*B*|\n')
})

test('mergeTableRow marks a modified table row per segment with no pipe inside a mark', () => {
  assert.equal(mergeTableRow('| A | B |', '| C | D |', 'md'), '|~~A~~*C*|~~B~~*D*|')
  assert.equal(mergeTableRow('| A | B |', '| A | B |', 'md'), '| A | B |')
})

test('mergeTableRow leaves equal segments literal and marks only new cells', () => {
  // A column appended: the existing cells are unchanged, only the new cell is added.
  assert.equal(mergeTableRow('| name | qty |', '| name | qty | note |', 'md'), '| name | qty |*note*|')
})

test('mergeTableRow drops a removed cell instead of emitting a phantom column', () => {
  assert.equal(mergeTableRow('| name | qty | note |', '| name | qty |', 'md'), '| name | qty |')
})

test('mergeTableRow swaps two cells as per-segment del+add', () => {
  assert.equal(mergeTableRow('| apple | 3 |', '| 3 | apple |', 'md'), '|~~apple~~*3*|~~3~~*apple*|')
})

test('adding a column keeps the delimiter row verbatim and marks header/body per segment', () => {
  const text = '| name | qty | note |\n| --- | --- | --- |\n| apple | 3 | fresh |\n'
  const marked = injectMarkdown(text, payload([
    { line: 1, kind: 'modified', oldText: '| name | qty |', newText: '| name | qty | note |' },
    { line: 2, kind: 'modified', oldText: '| --- | --- |', newText: '| --- | --- | --- |' },
    { line: 3, kind: 'modified', oldText: '| apple | 3 |', newText: '| apple | 3 | fresh |' },
  ]))
  assert.equal(marked, '| name | qty |*note*|\n| --- | --- | --- |\n| apple | 3 |*fresh*|\n')
})

test('removing a column leaves the table intact and marks nothing inside it', () => {
  const text = '| name | qty |\n| --- | --- |\n| apple | 3 |\n'
  const marked = injectMarkdown(text, payload([
    { line: 1, kind: 'modified', oldText: '| name | qty | note |', newText: '| name | qty |' },
    { line: 2, kind: 'modified', oldText: '| --- | --- | --- |', newText: '| --- | --- |' },
    { line: 3, kind: 'modified', oldText: '| apple | 3 | fresh |', newText: '| apple | 3 |' },
  ]))
  assert.equal(marked, '| name | qty |\n| --- | --- |\n| apple | 3 |\n')
})

test('delimiter alignment changes are never marked but the table stays whole', () => {
  const text = '| name | qty |\n| :--- | ---: |\n| apple | 3 |\n'
  const marked = injectMarkdown(text, payload([
    { line: 2, kind: 'modified', oldText: '| --- | --- |', newText: '| :--- | ---: |' },
  ]))
  assert.equal(marked, '| name | qty |\n| :--- | ---: |\n| apple | 3 |\n')
})

test('injectMarkdownHtml marks a modified table row per segment with entities', () => {
  const marked = injectMarkdownHtml('| name | qty | note |\n| --- | --- | --- |\n', payload([
    { line: 1, kind: 'modified', oldText: '| name | qty |', newText: '| name | qty | note |' },
    { line: 2, kind: 'modified', oldText: '| --- | --- |', newText: '| --- | --- | --- |' },
  ]))
  assert.equal(marked, '| name | qty |&#60;span data-gm="add"&#62;note&#60;/span&#62;|\n| --- | --- | --- |\n')
})

test('a deleted table row is replayed with per-segment del marks', () => {
  const text = 'intro\n\nbeta\n'
  const marked = injectMarkdown(text, payload([], [{ line: 3, text: '| removed | row |' }]))
  assert.equal(marked, 'intro\n\n|~~removed~~|~~row~~|\n\nbeta\n')
})

test('an untracked table is marked per segment with the delimiter kept bare', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  const marked = injectMarkdown(text, { kind: 'text', version: 'v1', lines: [], deletions: [], untracked: true })
  assert.equal(marked, '|*a*|*b*|\n| --- | --- |\n|*1*|*2*|\n')
})

test('injectMarkdown keeps a fenced block verbatim in an untracked file', () => {
  const text = 'alpha\n```\ncode\n```\n'
  const marked = injectMarkdown(text, { kind: 'text', version: 'v1', lines: [], deletions: [], untracked: true })
  assert.equal(marked, '*alpha*\n```\ncode\n```\n')
})

test('isBlockLine recognises the structural lines that must stay unmarked', () => {
  for (const line of ['', '   ', '# h', '> quote', '- item', '1. item', '```js', '---', '<div>', '| a |']) {
    assert.equal(isBlockLine(line), true, line)
  }
  for (const line of ['plain text', 'text with # hash', 'a - b']) {
    assert.equal(isBlockLine(line), false, line)
  }
})

test('isFenceLine recognises backtick and tilde fences', () => {
  assert.equal(isFenceLine('```js'), true)
  assert.equal(isFenceLine('  ~~~'), true)
  assert.equal(isFenceLine('`inline`'), false)
})

test('parseFileAddress decodes a session file address', () => {
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-1/docs/note%20one.md'),
    { scope: 'session', sessionId: 'session-1', path: 'docs/note one.md' },
  )
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-1/note.md?v=2#top'),
    { scope: 'session', sessionId: 'session-1', path: 'note.md' },
  )
  assert.equal(parseFileAddress('dsh-resource://file/workspace/w/docs/note.md'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/session/session-1'), undefined)
  assert.equal(parseFileAddress(undefined), undefined)
})

test('gitMarkFileAddress makes a path inside the root workspace-relative', () => {
  assert.equal(
    gitMarkFileAddress('session-1', 'C:\\work\\demo', 'C:\\work\\demo\\docs\\note.md'),
    'dsh-resource://file/session/session-1/docs/note.md',
  )
})

test('gitMarkFileAddress keeps an absolute spelling for a path outside the root', () => {
  assert.equal(
    gitMarkFileAddress('session-1', 'C:\\work\\demo', 'D:\\other\\note.md'),
    'dsh-resource://file/session/session-1/D:/other/note.md',
  )
})

test('gitMarkFileAddress encodes segments and leaves drive colons literal', () => {
  assert.equal(
    gitMarkFileAddress('session-9', undefined, 'C:\\docs\\my note.md'),
    'dsh-resource://file/session/session-9/C:/docs/my%20note.md',
  )
})

test('gitMarkFileAddress round-trips through parseFileAddress', () => {
  const address = gitMarkFileAddress('session-1', 'C:\\work', 'C:\\work\\sub\\note one.md')
  assert.deepEqual(parseFileAddress(address), { scope: 'session', sessionId: 'session-1', path: 'sub/note one.md' })
})

test('markdownImageUrl resolves a sibling image beside the document', () => {
  const url = markdownImageUrl('http://127.0.0.1:57761/', 'C:\\docs\\note.md', 'img/pic.png')
  assert.equal(url, 'http://127.0.0.1:57761/api/file?path=C%3A%5Cdocs%5Cimg%2Fpic.png')
  // Authored absolute URLs and foreign schemes are not rewritten.
  assert.equal(markdownImageUrl('http://127.0.0.1:57761/', 'C:\\docs\\note.md', 'https://example.com/a.png'), undefined)
  // A relative destination needs the Host-reported absolute path.
  assert.equal(markdownImageUrl('http://127.0.0.1:57761/', undefined, 'pic.png'), undefined)
})
