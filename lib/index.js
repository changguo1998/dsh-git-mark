/**
 * dsh-git-mark host half: change facts for a Markdown document relative to
 * HEAD, plus the "marked copy" renderer that writes a mixed Markdown/HTML
 * document (with `data-gm` marks) under `<workspace>/.dsh/git-mark/` so the
 * user's own viewer — better-sidebar — displays it with the full Markdown
 * syntax.
 *
 * Git commands run with an argv array (never a shell), a bounded runtime, and
 * bounded output. Only the request source file is ever written, and only under
 * one fixed `.dsh/git-mark/` directory that this route creates.
 */
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { buildLineInfo } from '../src/diff-parse.mjs'
import { injectMarkdownHtml } from '../src/client/inject.mjs'

/** Plugin name shown by the Loader. */
export const name = 'git-mark'

/** Authenticated browser route; the client fetches the same absolute path. */
const ROUTE_PATH = '/api/dsh-git-mark'

/** The subdirectory (below the Session workspace) marked copies are written to. */
const MARK_DIR = '.dsh/git-mark'

/** Largest diff this route will read (the viewer only needs hunks). */
const DIFF_MAX_BYTES = 4 * 1024 * 1024

/** Largest `git status` output this route will read. */
const STATUS_MAX_BYTES = 64 * 1024

/** Largest document this route will describe; larger files show no marks. */
const FILE_MAX_BYTES = 2 * 1024 * 1024

/** Longest absolute copy path this route will write (Windows 260-char bound). */
const MAX_PATH_LENGTH = 260

/** Upper bound on any single git invocation. */
const GIT_TIMEOUT_MS = 8_000

/** How long a terminated git child may take to leave. */
const GIT_GRACE_MS = 2_000

/**
 * Environment every git child runs with: no prompts, no pagers, no optional
 * locks, and a stable C locale so output parsing is byte-deterministic. The
 * ambient process environment is kept so git still finds HOME and SystemRoot.
 */
function gitEnvironment() {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    LC_ALL: 'C',
    LANG: 'C',
  }
}

/**
 * Run one git invocation through the Host subprocess service.
 * @param subprocess - the `ctx.subprocess` implementation.
 * @param gitPath - resolved git executable.
 * @param args - argv tail; never passed through a shell.
 * @param cwd - directory the command runs in.
 * @param signal - cancellation from the HTTP request.
 * @param stdoutMax - byte cap for standard output.
 * @returns exit code and captured text; a spawn failure reports code -1.
 */
async function runGit(subprocess, gitPath, args, cwd, signal, stdoutMax) {
  const limit = AbortSignal.timeout(GIT_TIMEOUT_MS)
  const combined = AbortSignal.any !== undefined && signal !== undefined
    ? AbortSignal.any([signal, limit])
    : limit
  let handle
  try {
    handle = subprocess.spawn({
      argv: [gitPath, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: stdoutMax },
        stderr: { maxBytes: STATUS_MAX_BYTES },
      },
      graceMs: GIT_GRACE_MS,
      signal: combined,
      env: gitEnvironment(),
    })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { exitCode: outcome.exitCode === null ? -1 : outcome.exitCode, stdout, stderr }
}

/** Answer the browser with one JSON payload and never let it be cached. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Resolve one request path inside the Session's workspace and verify it stays
 * inside it. Both a workspace-relative spelling and an absolute spelling are
 * accepted; anything that escapes the workspace (or a NUL) is refused.
 * @param cwd - the Session's live working directory.
 * @param value - the path the browser asked for.
 * @returns the absolute path to read, or undefined when it is not usable.
 */
function resolveRequestedPath(cwd, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) return undefined
  let candidate
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[/\\]/.test(value)) {
    candidate = value.replace(/\\/g, sep)
  } else {
    candidate = resolve(cwd, value)
  }
  const fromCwd = relative(cwd, candidate)
  if (fromCwd === '' || fromCwd.startsWith('..') || isAbsolute(fromCwd)) return undefined
  return candidate
}

/**
 * Resolve the Session and its file, verifying the request stays inside the
 * Session's workspace.
 * @param scope - context carrying sessions and workingDirectory.
 * @param sessionId - the browser-named session.
 * @param path - the browser-named path (absolute or workspace-relative).
 * @returns `{ cwd, filePath }`, or `{ kind, status }` for the failure payload.
 */
function sessionTarget(scope, sessionId, path) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { kind: 'no-session' }
  const sessions = scope.get('sessions')
  const session = sessions?.get(sessionId)
  if (session === undefined || session === null) return { kind: 'no-session' }
  const workingDirectory = scope.get('workingDirectory')
  // The live effective directory wins: a session may have changed it since it
  // was created, and the header keeps only the creation-time value.
  let cwd
  try {
    cwd = workingDirectory?.get(session)
  } catch {
    cwd = undefined
  }
  if (typeof cwd !== 'string' || cwd.length === 0) cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return { kind: 'not-git' }
  const filePath = resolveRequestedPath(cwd, path)
  if (filePath === undefined) return { kind: 'bad-path', status: 400 }
  return { cwd, filePath }
}

/**
 * Collect the git change facts for one file.
 * @param scope - context carrying subprocess.
 * @param gitPath - the resolved git executable.
 * @param cwd - the Session workspace root.
 * @param filePath - the addressed file.
 * @param signal - cancellation from the HTTP request.
 * @returns the facts payload the client consumes, or undefined when the file
 * has no usable git baseline (no git, no repository, or too large).
 */
async function gitFacts(scope, gitPath, cwd, filePath, signal) {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return undefined
  }
  if (!fileStat.isFile() || fileStat.size > FILE_MAX_BYTES) return { kind: 'too-large' }
  const subprocess = scope.get('subprocess')
  if (subprocess === undefined || subprocess === null) return undefined
  let resolved = gitPath
  if (resolved === undefined) {
    try {
      resolved = await subprocess.resolveExecutable('git')
    } catch {
      return undefined
    }
  }

  // The repository that owns the *file* wins: a workspace may itself be outside
  // Git while a document sits inside a repository, and a nested repository must
  // not be judged by an enclosing one.
  let root
  for (const start of [dirname(filePath), cwd]) {
    const rootRun = await runGit(subprocess, resolved, ['rev-parse', '--show-toplevel'], start, signal, STATUS_MAX_BYTES)
    const candidate = rootRun.exitCode === 0 ? rootRun.stdout.trim() : ''
    if (candidate.length > 0) {
      const beside = relative(candidate, filePath)
      if (beside !== '' && !beside.startsWith('..') && !isAbsolute(beside)) {
        root = candidate
        break
      }
    }
  }
  if (root === undefined) return undefined

  // Git speaks forward slashes; keep the addressed file inside the worktree.
  const relPath = relative(root, filePath)
  if (relPath === '' || relPath.startsWith('..') || isAbsolute(relPath)) return undefined
  const gitPathSpec = relPath.split(sep).join('/')

  const headRun = await runGit(subprocess, resolved, ['rev-parse', '--verify', 'HEAD'], root, signal, STATUS_MAX_BYTES)
  const headOid = headRun.exitCode === 0 ? headRun.stdout.trim() : undefined

  const statusRun = await runGit(
    subprocess, resolved, ['status', '--porcelain', '--untracked-files=normal', '--', gitPathSpec],
    root, signal, STATUS_MAX_BYTES,
  )
  const statusText = statusRun.exitCode === 0 ? statusRun.stdout : ''

  // Untracked files have no diff worth running: the client marks the whole file.
  const untracked = statusText.split('\n').some(line => line.startsWith('??'))
  const diffRun = untracked
    ? { exitCode: 0, stdout: '' }
    : await runGit(
      subprocess, resolved,
      ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--unified=0', '--text', '--', gitPathSpec],
      root, signal, DIFF_MAX_BYTES,
    )
  if (!untracked && diffRun.exitCode !== 0) {
    scope.logger?.warn?.(`git-mark: git diff failed for ${gitPathSpec}: ${(diffRun.stderr ?? '').slice(0, 400)}`)
  }
  return {
    kind: 'text',
    ...buildLineInfo({
      headOid,
      diffText: diffRun.exitCode === 0 ? diffRun.stdout : '',
      statusText,
    }),
  }
}

/**
 * Answer the read-only facts GET.
 * @param scope - context carrying sessions, workingDirectory, and subprocess.
 * @param request - the browser's GET request.
 * @returns the payload the client renders.
 */
async function describe(scope, request) {
  const url = new URL(request.url)
  const target = sessionTarget(scope, url.searchParams.get('sessionId'), url.searchParams.get('path'))
  if (target.kind !== undefined) return json(target, target.status ?? 200)
  // A marked copy is never annotated again: its marks were computed from its
  // source, and marking the copy itself would create the “marks of the marks”.
  if (isInsideMarkDir(target.cwd, target.filePath)) return json({ kind: 'not-git' })
  const facts = await gitFacts(scope, undefined, target.cwd, target.filePath, request.signal)
  return facts === undefined ? json({ kind: 'not-git' }) : json(facts)
}

/**
 * Whether a path lies under the Session's marked-copy tree — the mirror of the
 * workspace below `<cwd>/.dsh/git-mark/`. The trailing separator keeps a
 * sibling name like `.dsh/git-markers` out of the guard.
 * @param cwd - the Session's live working directory.
 * @param filePath - the absolute path to test.
 * @returns true when the path is inside the mark tree.
 */
function isInsideMarkDir(cwd, filePath) {
  const prefix = join(cwd, MARK_DIR) + sep
  return typeof filePath === 'string' && filePath.startsWith(prefix)
}

/**
 * Where a source file's marked copy lives (mirror layout): the same relative
 * path as the source, below `<cwd>/.dsh/git-mark/`. Basename and folder
 * structure are preserved, so two sources with the same name never collide and
 * the copy's own path encodes its source.
 * @param cwd - the Session's live working directory.
 * @param sourcePath - the absolute source path.
 * @returns the absolute copy path, or undefined when it cannot be expressed.
 */
function copyPathOf(cwd, sourcePath) {
  const rel = relative(cwd, sourcePath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return join(cwd, MARK_DIR, rel)
}

/**
 * Recover the source path of a marked copy: strip the mirror-tree prefix, then
 * join the remainder back under the workspace. The result is refused when it
 * escapes the workspace or still lives under the mark tree (a marked copy can
 * never be the source of another copy).
 * @param cwd - the Session's live working directory.
 * @param copyPath - the absolute path of the marked copy.
 * @returns the absolute source path, or undefined when it is not usable.
 */
function sourceOf(cwd, copyPath) {
  const prefix = join(cwd, MARK_DIR) + sep
  if (typeof copyPath !== 'string' || !copyPath.startsWith(prefix)) return undefined
  const rel = copyPath.slice(prefix.length)
  if (rel.length === 0 || rel.split(sep).includes('..')) return undefined
  const source = join(cwd, rel)
  return isInsideMarkDir(cwd, source) ? undefined : source
}

/**
 * Source fingerprint of every copy this process generated, keyed by the copy's
 * absolute path. The watcher compares against it first, so an unchanged source
 * costs one `stat` and no git invocation.
 */
const copyBaselines = new Map()

/**
 * Remember the current source fingerprint for one copy.
 * @param copyPath - absolute marked-copy path.
 * @param sourcePath - absolute source path it mirrors.
 */
async function rememberBaseline(copyPath, sourcePath) {
  try {
    const info = await stat(sourcePath)
    copyBaselines.set(copyPath, { mtimeMs: info.mtimeMs, size: info.size })
  } catch {
    copyBaselines.delete(copyPath)
  }
}

/**
 * Build the marked text of one source file.
 * @param scope - context carrying subprocess (for git).
 * @param cwd - the Session workspace root.
 * @param sourcePath - the absolute source file.
 * @param signal - cancellation from the HTTP request.
 * @returns `{ marked, facts }`, or `{ response }` holding a failure payload.
 */
async function buildMarkedCopy(scope, cwd, sourcePath, signal) {
  const facts = await gitFacts(scope, undefined, cwd, sourcePath, signal)
  if (facts === undefined) return { response: json({ kind: 'not-git' }) }
  if (facts.kind !== 'text') return { response: json(facts) }
  let text
  try {
    text = await readFile(sourcePath, 'utf8')
  } catch {
    return { response: json({ kind: 'not-git' }) }
  }
  try {
    return { marked: injectMarkdownHtml(text, facts), facts }
  } catch (error) {
    scope.logger?.warn?.(`git-mark: mark generation failed: ${String(error)}`)
    return { response: json({ kind: 'error' }, 500) }
  }
}

/**
 * Write one mirror copy, creating its mirror directories.
 * @param scope - context carrying logger.
 * @param outPath - absolute copy path.
 * @param marked - document text to write.
 * @returns undefined on success, or the failure payload.
 */
async function writeCopy(scope, outPath, marked) {
  if (outPath === undefined || outPath.length >= MAX_PATH_LENGTH) return json({ kind: 'toolong' })
  try {
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, marked, 'utf8')
  } catch (error) {
    scope.logger?.warn?.(`git-mark: writing ${outPath} failed: ${String(error)}`)
    return json({ kind: 'error' }, 500)
  }
  return undefined
}

/**
 * Answer the render POST: read the source file, mark it, and write (or refresh)
 * its mirror copy under `<workspace>/.dsh/git-mark/`. A request that names a
 * marked copy refreshes that copy from its own source — recovered by stripping
 * the mirror prefix — instead of annotating the copy.
 * @param scope - context carrying sessions, workingDirectory, and subprocess.
 * @param request - the browser's POST request.
 * @returns the written copy path, or a graceful failure payload.
 */
async function render(scope, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ kind: 'bad-path' }, 400)
  }
  const target = sessionTarget(scope, body.sessionId, body.path)
  if (target.kind !== undefined) return json(target, target.status ?? 200)

  // The mirror tree maps copy → source; a path inside it is a refresh request.
  const isCopy = isInsideMarkDir(target.cwd, target.filePath)
  const sourcePath = isCopy ? sourceOf(target.cwd, target.filePath) : target.filePath
  if (sourcePath === undefined) return json({ kind: 'no-source' })

  const built = await buildMarkedCopy(scope, target.cwd, sourcePath, request.signal)
  if (built.response !== undefined) return built.response

  // Mirror layout keeps the same relative path, so a refresh overwrites in
  // place and two same-named sources never collide.
  const outPath = isCopy ? target.filePath : copyPathOf(target.cwd, sourcePath)
  if (outPath === undefined || outPath.length >= MAX_PATH_LENGTH) return json({ kind: 'toolong' })
  let previous
  try {
    previous = await readFile(outPath, 'utf8')
  } catch {
    previous = undefined
  }
  const failed = await writeCopy(scope, outPath, built.marked)
  if (failed !== undefined) return failed
  await rememberBaseline(outPath, sourcePath)
  return json({
    kind: 'created',
    path: outPath,
    relativePath: relative(target.cwd, outPath),
    sourcePath: relative(target.cwd, sourcePath),
    refreshed: isCopy,
    changed: previous !== built.marked,
    version: built.facts.version,
  })
}

/**
 * Answer the watcher's GET: decide whether one copy's source changed, and
 * regenerate the copy only when it did. An unchanged source short-circuits on
 * one `stat` against the in-process baseline, so the browser's poll is cheap.
 * @param scope - context carrying sessions, workingDirectory, and subprocess.
 * @param request - the browser's GET request (`sessionId`, `path` = the copy).
 * @returns `{ kind: 'checked', changed }` with the copy path, or a failure payload.
 */
async function watch(scope, request) {
  const url = new URL(request.url)
  const target = sessionTarget(scope, url.searchParams.get('sessionId'), url.searchParams.get('path'))
  if (target.kind !== undefined) return json(target, target.status ?? 200)
  if (!isInsideMarkDir(target.cwd, target.filePath)) return json({ kind: 'bad-path' }, 400)
  const sourcePath = sourceOf(target.cwd, target.filePath)
  if (sourcePath === undefined) return json({ kind: 'no-source' })

  let info
  try {
    info = await stat(sourcePath)
  } catch {
    return json({ kind: 'no-source' })
  }
  if (!info.isFile()) return json({ kind: 'no-source' })
  if (info.size > FILE_MAX_BYTES) return json({ kind: 'too-large' })

  const baseline = copyBaselines.get(target.filePath)
  if (baseline !== undefined && baseline.mtimeMs === info.mtimeMs && baseline.size === info.size) {
    return json({ kind: 'checked', changed: false })
  }

  const built = await buildMarkedCopy(scope, target.cwd, sourcePath, request.signal)
  if (built.response !== undefined) return built.response
  let previous
  try {
    previous = await readFile(target.filePath, 'utf8')
  } catch {
    previous = undefined
  }
  const changed = previous !== built.marked
  if (changed) {
    const failed = await writeCopy(scope, target.filePath, built.marked)
    if (failed !== undefined) return failed
  }
  copyBaselines.set(target.filePath, { mtimeMs: info.mtimeMs, size: info.size })
  return json({ kind: 'checked', changed, path: target.filePath, version: built.facts.version })
}

/**
 * Mount the routes for the lifetime of the owning fiber.
 * @param ctx - plugin context; every service is required before mounting.
 */
export function apply(ctx) {
  ctx.inject(['connection', 'subprocess', 'sessions', 'workingDirectory'], (scope) => {
    const connection = scope.get('connection')
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (register === undefined) {
      ctx.logger?.warn?.('git-mark: connection.fetch.register is unavailable; change marks stay off.')
      return
    }
    const safe = (handler) => async (request) => {
      try {
        return await handler(scope, request)
      } catch (error) {
        ctx.logger?.warn?.(`git-mark: ${String(error)}`)
        return json({ kind: 'error' }, 500)
      }
    }
    scope.effect(() => register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: safe(describe),
    }))
    scope.effect(() => register({
      path: `${ROUTE_PATH}/render`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: safe(render),
    }))
    scope.effect(() => register({
      path: `${ROUTE_PATH}/watch`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: safe(watch),
    }))
    ctx.logger?.info?.(`git-mark: routes mounted at ${ROUTE_PATH}, ${ROUTE_PATH}/render, and ${ROUTE_PATH}/watch`)
  })
}
