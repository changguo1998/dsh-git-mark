/** Host half end-to-end: the mounted route handler over a real repository. */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { assert, test } from './harness.mjs'
import { apply } from '../lib/index.js'
import { injectMarkdown } from '../src/client/inject.mjs'

/** Temporary repositories this suite created. */
const created = []

/**
 * A `ctx.subprocess` stand-in that spawns real processes.
 * @returns the service shape lib/index.js consumes.
 */
function fakeSubprocess() {
  return {
    async resolveExecutable(command) {
      if (command !== 'git') throw new Error(`unexpected executable ${command}`)
      return 'git'
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      /** @type {Buffer[]} */
      const out = []
      /** @type {Buffer[]} */
      const err = []
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
      const done = new Promise((resolve) => {
        child.on('error', () => resolve({ exitCode: -1, signal: null }))
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      const reader = (chunks) => ({
        readFrom: () => {
          const text = Buffer.concat(chunks).toString('utf8')
          return { text, nextOffset: text.length, lossy: false }
        },
      })
      return { collected: { stdout: reader(out), stderr: reader(err) }, done, terminate() { child.kill() } }
    },
  }
}

/**
 * Mount the plugin against a fake host context and return the route handlers.
 * @param options - session directory and the live session ids.
 * @returns `{ get, post }` route handlers keyed by method.
 */
function mount(options) {
  /** @type {Record<string, Function>} */
  const routes = {}
  const scope = {
    get(name) {
      if (name === 'connection') return { fetch: { register: (route) => { routes[route.methods[0]] = route.fetch; return () => {} } } }
      if (name === 'subprocess') return fakeSubprocess()
      if (name === 'sessions') {
        return {
          get: (id) => (options.sessions.includes(id) ? { header: { cwd: options.cwd } } : undefined),
        }
      }
      if (name === 'workingDirectory') return { get: () => options.cwd }
      return undefined
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    logger: { info: () => {}, warn: (message) => console.log(`     (host warn) ${message}`) },
  }
  apply({
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['connection', 'subprocess', 'sessions', 'workingDirectory'])
      callback(scope)
    },
    logger: scope.logger,
  })
  assert.equal(typeof routes.GET, 'function', 'the facts route must be mounted')
  assert.equal(typeof routes.POST, 'function', 'the render route must be mounted')
  return { facts: routes.GET, render: routes.POST }
}

/**
 * Ask the mounted facts route for one document.
 * @param handler - registered GET fetch callback.
 * @param query - query string without the leading `?`.
 * @returns the parsed JSON body and status.
 */
async function get(handler, query) {
  const response = await handler(new Request(`http://127.0.0.1:1/api/dsh-git-mark?${query}`))
  return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') }
}

/**
 * Ask the mounted render route to write a marked copy.
 * @param handler - registered POST fetch callback.
 * @param payload - JSON body.
 * @returns the parsed JSON body and status.
 */
async function post(handler, payload) {
  const response = await handler(new Request('http://127.0.0.1:1/api/dsh-git-mark/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') }
}

/**
 * Create a repository holding one committed document.
 * @returns its root directory.
 */
async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-mark-route-'))
  created.push(root)
  await initRepo(root, { 'docs/note.md': '# Note\n\nalpha keep\n\nold line\n\nomega keep\n' })
  return root
}

/**
 * Turn one directory into a repository with one commit.
 * @param dir - absolute directory to initialize.
 * @param files - relative path to committed content.
 */
async function initRepo(dir, files) {
  const git = (args) => execFileSync('git', args, {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0' },
  })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'dsh-git-mark test'])
  git(['config', 'core.autocrlf', 'false'])
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content, 'utf8')
  }
  git(['add', '--all'])
  git(['commit', '-q', '-m', 'initial', '--no-verify'])
}

test('the mounted route answers the change facts for an edited document', async () => {
  const root = await makeRepo()
  const { facts } = mount({ cwd: root, sessions: ['session-1'] })
  await writeFile(join(root, 'docs/note.md'), '# Note\n\nalpha keep changed\n\nomega keep\n', 'utf8')

  const answer = await get(facts, 'sessionId=session-1&path=docs/note.md')
  assert.equal(answer.status, 200)
  assert.equal(answer.cacheControl, 'no-store')
  assert.equal(answer.body.kind, 'text')
  assert.equal(answer.body.untracked, false)
  assert.equal(answer.body.deletions.length, 1)
  assert.equal(answer.body.deletions[0].text, 'old line')
  assert.equal(answer.body.lines.length, 1)
  assert.equal(answer.body.lines[0].kind, 'modified')

  const marked = injectMarkdown('# Note\n\nalpha keep changed\n\nomega keep\n', answer.body)
  assert.ok(marked.includes('~~old line~~'), marked)
  assert.ok(marked.includes('* changed*'), marked)
})

test('the route reports an untracked document', async () => {
  const root = await makeRepo()
  const { facts } = mount({ cwd: root, sessions: ['session-1'] })
  await writeFile(join(root, 'docs/fresh.md'), 'fresh text\n', 'utf8')
  const answer = await get(facts, 'sessionId=session-1&path=docs/fresh.md')
  assert.equal(answer.body.kind, 'text')
  assert.equal(answer.body.untracked, true)
})

test('the route accepts an absolute path inside the workspace', async () => {
  const root = await makeRepo()
  await writeFile(join(root, 'docs/note.md'), '# Note\n\nalpha keep changed\n\nomega keep\n', 'utf8')
  const { facts } = mount({ cwd: root, sessions: ['session-1'] })
  const absolute = join(root, 'docs/note.md')
  const answer = await get(facts, `sessionId=session-1&path=${encodeURIComponent(absolute)}`)
  assert.equal(answer.body.kind, 'text')
  assert.equal(answer.body.lines.length, 1)
})

test('the route refuses an unknown session, an absolute path, and an escape', async () => {
  const root = await makeRepo()
  const { facts } = mount({ cwd: root, sessions: ['session-1'] })
  assert.equal((await get(facts, 'path=docs/note.md')).body.kind, 'no-session')
  assert.equal((await get(facts, 'sessionId=nope&path=docs/note.md')).body.kind, 'no-session')
  assert.equal((await get(facts, 'sessionId=session-1&path=C%3A%5CWindows%5Cwin.ini')).status, 400)
  assert.equal((await get(facts, 'sessionId=session-1&path=..%2F..%2Fetc%2Fpasswd')).status, 400)
})

test('the route reports not-git outside a repository and for a missing file', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'dsh-git-mark-plain-'))
  created.push(plain)
  await writeFile(join(plain, 'note.md'), 'text\n', 'utf8')
  const { facts } = mount({ cwd: plain, sessions: ['session-1'] })
  assert.equal((await get(facts, 'sessionId=session-1&path=note.md')).body.kind, 'not-git')
  const repo = await makeRepo()
  const inRepo = mount({ cwd: repo, sessions: ['session-1'] })
  assert.equal((await get(inRepo.facts, 'sessionId=session-1&path=docs/missing.md')).body.kind, 'not-git')
})

test('a nested repository inside a non-git workspace is still resolved', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-git-mark-nested-'))
  created.push(workspace)
  const nested = join(workspace, 'demo')
  await mkdir(nested, { recursive: true })
  await initRepo(nested, { 'note.md': '# Note\n\nfirst line\n' })
  await writeFile(join(nested, 'note.md'), '# Note\n\nfirst line edited\n', 'utf8')

  const { facts } = mount({ cwd: workspace, sessions: ['session-1'] })
  const answer = await get(facts, `sessionId=session-1&path=demo/note.md`)
  assert.equal(answer.body.kind, 'text')
  assert.equal(answer.body.lines.length, 1)
  assert.equal(answer.body.lines[0].kind, 'modified')
})

test('the render route writes a mirror copy under .dsh/git-mark and returns it', async () => {
  const root = await makeRepo()
  const edited = '# Note\n\nalpha keep changed\n\nomega keep\n'
  await writeFile(join(root, 'docs/note.md'), edited, 'utf8')
  const { render } = mount({ cwd: root, sessions: ['session-1'] })

  const answer = await post(render, { sessionId: 'session-1', path: 'docs/note.md' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.kind, 'created')
  // Mirror layout: same relative path under .dsh/git-mark, original basename.
  assert.equal(answer.body.relativePath.replace(/\\/g, '/'), '.dsh/git-mark/docs/note.md')
  assert.equal(answer.body.refreshed, false)
  assert.equal(answer.body.sourcePath.replace(/\\/g, '/'), 'docs/note.md')

  const written = await readFile(answer.body.path, 'utf8')
  assert.ok(written.includes('data-gm="add"'), written)
  assert.ok(written.includes('alpha keep&#60;span data-gm="add"&#62; changed&#60;/span&#62;'), written)
  assert.ok(written.includes('&#60;del data-gm="del"&#62;old line&#60;/del&#62;'), 'whole deleted line must be replayed')
  // Every surviving source line is present (marks stripped); nothing was lost.
  const plain = written.replace(/<.*?>/g, '').replace(/&#60;.*?&#62;/g, '')
  for (const line of ['# Note', 'alpha keep changed', 'omega keep']) {
    assert.ok(plain.includes(line), line)
  }

  // The original file is untouched.
  assert.equal(await readFile(join(root, 'docs/note.md'), 'utf8'), edited)
})

test('mirror layout keeps basenames and nesting, including non-ASCII names', async () => {
  const root = await makeRepo()
  const { render } = mount({ cwd: root, sessions: ['session-1'] })
  await writeFile(join(root, 'docs', '指南 笔记.md'), '# 指南\n\n第一行\n', 'utf8')
  const answer = await post(render, { sessionId: 'session-1', path: 'docs/指南 笔记.md' })
  assert.equal(answer.body.kind, 'created')
  const expected = join(root, '.dsh', 'git-mark', 'docs', '指南 笔记.md')
  assert.equal(answer.body.path, expected)
  assert.equal(await readFile(expected, 'utf8'), '# 指南\n\n&#60;span data-gm="add"&#62;第一行&#60;/span&#62;\n')
})

test('a copy refresh regenerates the same mirror file from its source', async () => {
  const root = await makeRepo()
  const { render } = mount({ cwd: root, sessions: ['session-1'] })
  const first = await post(render, { sessionId: 'session-1', path: 'docs/note.md' })
  assert.equal(first.body.kind, 'created')
  const copyPath = first.body.path
  assert.equal(copyPath, join(root, '.dsh', 'git-mark', 'docs', 'note.md'))
  const firstText = await readFile(copyPath, 'utf8')

  // Now the source changes; refreshing the copy must regenerate in place.
  await writeFile(join(root, 'docs/note.md'), '# Note\n\nalpha keep changed twice\n\nomega keep\n', 'utf8')
  const second = await post(render, { sessionId: 'session-1', path: '.dsh/git-mark/docs/note.md' })
  assert.equal(second.body.kind, 'created')
  assert.equal(second.body.refreshed, true)
  assert.equal(second.body.path, copyPath, 'refresh must overwrite the same copy')
  assert.equal(second.body.sourcePath.replace(/\\/g, '/'), 'docs/note.md')

  const secondText = await readFile(copyPath, 'utf8')
  assert.ok(secondText.includes('changed twice'), secondText)
  assert.notEqual(secondText, firstText)
  // The mirror file is still the only copy: no “copy of a copy” was created.
  assert.equal(copyPath, join(root, '.dsh', 'git-mark', 'docs', 'note.md'))
  assert.match(await readFile(join(root, '.dsh', 'git-mark', 'docs', 'note.md'), 'utf8'), /changed twice/u)
})

test('a marked copy is never annotated by the facts route', async () => {
  const root = await makeRepo()
  const { render, facts } = mount({ cwd: root, sessions: ['session-1'] })
  await post(render, { sessionId: 'session-1', path: 'docs/note.md' })
  const answer = await get(facts, 'sessionId=session-1&path=.dsh/git-mark/docs/note.md')
  assert.equal(answer.body.kind, 'not-git')
})

test('the render route answers no-source for a mark path whose source is missing', async () => {
  const root = await makeRepo()
  const { render } = mount({ cwd: root, sessions: ['session-1'] })
  // `.dsh/git-mark/.dsh/git-mark/note.md` maps back into the mark tree.
  const answer = await post(render, { sessionId: 'session-1', path: '.dsh/git-mark/.dsh/git-mark/note.md' })
  assert.equal(answer.body.kind, 'no-source')
})

test('the render route refuses a copy path beyond the MAX_PATH bound', async () => {
  const root = await makeRepo()
  const deep = 'd'.repeat(240)
  await mkdir(join(root, deep), { recursive: true })
  await writeFile(join(root, deep, 'note.md'), '# Deep\n', 'utf8')
  const { render } = mount({ cwd: root, sessions: ['session-1'] })
  const answer = await post(render, { sessionId: 'session-1', path: `${deep}/note.md` })
  assert.equal(answer.body.kind, 'toolong')
})

test('the render route marks an untracked file whole-green', async () => {
  const root = await makeRepo()
  await writeFile(join(root, 'docs/fresh.md'), 'fresh line\n\n# heading\n', 'utf8')
  const { render } = mount({ cwd: root, sessions: ['session-1'] })
  const answer = await post(render, { sessionId: 'session-1', path: 'docs/fresh.md' })
  assert.equal(answer.body.kind, 'created')
  const written = await readFile(answer.body.path, 'utf8')
  assert.ok(written.includes('&#60;span data-gm="add"&#62;fresh line&#60;/span&#62;'), written)
  assert.ok(!written.includes('&#60;span data-gm="add"&#62;# heading&#60;/span&#62;'), 'block lines must stay untouched')
})

test('the render route reports not-git outside a repository and writes nothing', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'dsh-git-mark-plain-'))
  created.push(plain)
  await writeFile(join(plain, 'note.md'), 'text\n', 'utf8')
  const { render } = mount({ cwd: plain, sessions: ['session-1'] })
  const answer = await post(render, { sessionId: 'session-1', path: 'note.md' })
  assert.equal(answer.body.kind, 'not-git')
  await assert.rejects(readFile(join(plain, '.dsh', 'git-mark', 'note.md'), 'utf8'))
})

test('the render route accepts an absolute path inside the workspace', async () => {
  const root = await makeRepo()
  await writeFile(join(root, 'docs/note.md'), 'first line\nsecond line\n', 'utf8')
  const { render } = mount({ cwd: root, sessions: ['session-1'] })
  const answer = await post(render, { sessionId: 'session-1', path: join(root, 'docs/note.md') })
  assert.equal(answer.body.kind, 'created')
})

/** Remove every temporary directory this suite created. */
export async function cleanup() {
  for (const directory of created) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
