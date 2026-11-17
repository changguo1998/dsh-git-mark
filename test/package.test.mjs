/** Package shape: the manifest, the loader artifact, and the bundle patch. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.mjs'
import * as host from '../lib/index.js'

/** Package root, one level above test/. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a package-relative text file. */
async function read(relative) {
  return readFile(join(root, relative), 'utf8')
}

test('the host half exports a named cordis plugin', () => {
  assert.equal(host.name, 'git-mark')
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.apply.length, 1)
})

test('the browser half is a syntactically valid loader artifact', async () => {
  const source = await read('lib/client.js')
  assert.ok(source.includes('window.__ModuleLoader__.load('), 'loader wrapper missing')
  assert.ok(source.includes("id: 'dsh-git-mark'"), 'loader id missing')
  assert.ok(source.includes('factory(require)'), 'factory missing')
  assert.ok(source.includes('apply: applyGitMark'), 'apply missing')
  assert.ok(source.includes("require('@deepseek-ai/dsh-client-ui-primitives')"), 'primitives require missing')
  // Compiling without running catches a broken concatenation before the browser does.
  assert.doesNotThrow(() => new Function(source))
})

test('the manifest declares the bundle patch and the client platform', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.equal(manifest.name, 'dsh-git-mark')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-documentpreview'))
  // Every shipped entry point must exist in this checkout.
  const main = await read(manifest.main)
  assert.ok(main.includes('export function apply'))
})

test('the bundle patch only inserts this plugin\'s own row', async () => {
  const patch = await read('cordis.patch.yml')
  const lines = patch.split('\n')
  assert.deepEqual(lines.filter(line => /^\s*-?\s*id:/.test(line)).map(line => line.trim()), ['- id: git-mark'])
  assert.deepEqual(lines.filter(line => /^\s*-?\s*name:/.test(line)).map(line => line.trim()), ["name: 'dsh-git-mark'"])
  assert.equal(lines.filter(line => line.trim() === '- insert:').length, 1)
  // A patch must never reach into a shared host row.
  for (const verb of ['update:', 'remove:', 'override:']) {
    assert.ok(!patch.includes(verb), `patch must not use ${verb}`)
  }
  for (const shared of ['storage-domain', 'session-query-sqlite', 'working-directory', 'session-projection']) {
    assert.ok(!patch.includes(shared), `patch must not mention shared row ${shared}`)
  }
})

test('the README documents the implemented behaviour, not the draft', async () => {
  const readme = await read('README.md')
  assert.ok(!readme.includes('--word-diff'), 'README still describes the abandoned word-diff approach')
  assert.ok(readme.includes('/api/dsh-git-mark'), 'README should name the route')
})
