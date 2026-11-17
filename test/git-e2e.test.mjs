/** End-to-end: a real repository, the exact git argv the Host runs, real marks. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from './harness.mjs'
import { buildLineInfo } from '../src/diff-parse.mjs'
import { injectMarkdown } from '../src/client/inject.mjs'

/** Where the temporary repositories live; removed when the suite finishes. */
const created = []

/**
 * Run one git command the way lib/index.js runs it: argv array, no shell.
 * @param cwd - repository directory.
 * @param args - git arguments.
 * @returns standard output, or undefined when git itself is unavailable.
 */
function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
      },
    })
  } catch (error) {
    // A missing executable and a failing command both mean "no answer"; the
    // assertions below judge the parsed payload, not git's exit status.
    if (error && (error.code === 'ENOENT' || typeof error.status === 'number')) return undefined
    throw error
  }
}

/** Whether git can run here at all. */
const hasGit = git(process.cwd(), ['--version']) !== undefined

/**
 * Create one committed repository holding `docs/note.md`.
 * @param files - relative path to committed content.
 * @returns the repository root.
 */
async function makeRepo(files) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-mark-'))
  created.push(root)
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'dsh-git-mark test'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  // Keep bytes exact: no line-ending rewriting between the worktree and HEAD.
  git(root, ['config', 'core.autocrlf', 'false'])
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  git(root, ['add', '--all'])
  git(root, ['commit', '-q', '-m', 'initial', '--no-verify'])
  return root
}

/**
 * Reproduce the Host's read-only query for one workspace-relative path.
 * @param root - repository or workspace directory the command starts in.
 * @param path - workspace-relative document path.
 * @returns the payload shape the route answers with.
 */
async function query(root, path) {
  const toplevel = git(root, ['rev-parse', '--show-toplevel'])
  assert.ok(toplevel !== undefined, 'git executable is required')
  const top = toplevel.trim()
  const filePath = join(root, ...path.split('/'))
  const relPath = filePath.slice(top.length + 1).split('\\').join('/')
  const headRun = git(top, ['rev-parse', '--verify', 'HEAD'])
  const headOid = headRun === undefined ? undefined : headRun.trim()
  const statusText = git(top, ['status', '--porcelain', '--untracked-files=normal', '--', relPath]) ?? ''
  const untracked = statusText.split('\n').some(line => line.startsWith('??'))
  const diffText = untracked
    ? ''
    : git(top, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--unified=0', '--text', '--', relPath]) ?? ''
  return { kind: 'text', ...buildLineInfo({ headOid, diffText, statusText }) }
}

const COMMITTED = [
  '# Note',
  '',
  'alpha keep',
  '',
  'old paragraph here',
  '',
  'omega keep',
  '',
].join('\n')

const EDITED = [
  '# Note',
  '',
  'alpha keep changed',
  '',
  'omega keep',
  '',
  'brand new tail',
  '',
].join('\n')

test('a real repository reports modified, deleted, and added lines', async () => {
  if (!hasGit) {
    console.log('     (git is unavailable; skipping)')
    return
  }
  const root = await makeRepo({ 'docs/note.md': COMMITTED })
  await writeFile(join(root, 'docs/note.md'), EDITED, 'utf8')

  const payload = await query(root, 'docs/note.md')
  assert.equal(payload.kind, 'text')
  assert.equal(payload.untracked, false)
  assert.match(payload.version, /^[0-9a-f]{7,}$/)
  assert.equal(payload.deletions.length, 1)
  assert.equal(payload.deletions[0].text, 'old paragraph here')
  assert.equal(payload.lines.filter(entry => entry.kind === 'modified').length, 1)
  // The insertion also adds a blank separator line; only text is worth asserting.
  const added = payload.lines.filter(entry => entry.kind === 'added' && entry.newText.trim() !== '')
  assert.deepEqual(added.map(entry => entry.newText), ['brand new tail'])

  const marked = injectMarkdown(EDITED, payload)
  assert.ok(marked.includes('* changed*'), marked)
  assert.ok(marked.includes('~~old paragraph here~~'), marked)
  assert.ok(marked.includes('*brand new tail*'), marked)
  assert.ok(marked.includes('# Note'), marked)

  // The disk copy is never rewritten by marking.
  assert.equal(await readFile(join(root, 'docs/note.md'), 'utf8'), EDITED)
})

test('a repository without changes produces no marks', async () => {
  if (!hasGit) return
  const root = await makeRepo({ 'note.md': COMMITTED })
  const payload = await query(root, 'note.md')
  assert.deepEqual(payload.lines, [])
  assert.deepEqual(payload.deletions, [])
  assert.equal(payload.untracked, false)
  assert.equal(injectMarkdown(COMMITTED, payload), COMMITTED)
})

test('an untracked document is reported as untracked and marked green', async () => {
  if (!hasGit) return
  const root = await makeRepo({ 'note.md': COMMITTED })
  const fresh = 'brand new line\n\n# heading\ntail line\n'
  await writeFile(join(root, 'fresh.md'), fresh, 'utf8')
  const payload = await query(root, 'fresh.md')
  assert.equal(payload.untracked, true)
  const marked = injectMarkdown(fresh, payload)
  assert.ok(marked.includes('*brand new line*'), marked)
  assert.ok(marked.includes('*tail line*'), marked)
  assert.ok(!marked.includes('~~'), marked)
})

test('a staged-only change is still reported against HEAD', async () => {
  if (!hasGit) return
  const root = await makeRepo({ 'note.md': COMMITTED })
  const staged = `${COMMITTED}staged tail\n`
  await writeFile(join(root, 'note.md'), staged, 'utf8')
  git(root, ['add', '--', 'note.md'])
  const payload = await query(root, 'note.md')
  assert.equal(payload.lines.length, 1)
  assert.equal(payload.lines[0].kind, 'added')
  assert.ok(injectMarkdown(staged, payload).includes('*staged tail*'))
})

test('the workspace root nested inside a repository resolves to the worktree', async () => {
  if (!hasGit) return
  const root = await makeRepo({ 'sub/note.md': COMMITTED })
  const workspace = join(root, 'sub')
  await writeFile(join(root, 'sub/note.md'), EDITED, 'utf8')
  const payload = await query(workspace, 'note.md')
  assert.equal(payload.untracked, false)
  assert.equal(payload.deletions[0].text, 'old paragraph here')
})

test('a directory that is not a repository reports not-git', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'dsh-git-mark-plain-'))
  created.push(plain)
  await writeFile(join(plain, 'note.md'), COMMITTED, 'utf8')
  if (!hasGit) return
  const toplevel = git(plain, ['rev-parse', '--show-toplevel'])
  assert.equal(toplevel, undefined)
})

/** Remove every temporary directory this suite created. */
export async function cleanup() {
  for (const directory of created) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      console.error(`cleanup failed for ${directory}: ${String(error)}`)
    }
  }
}
