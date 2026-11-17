#!/usr/bin/env node
/**
 * Run every dsh-git-mark self-test with the runtime's own Node (no framework
 * and no build step exists here): `node test/run.mjs`.
 */
import './diff-parse.test.mjs'
import './inject.test.mjs'
import './package.test.mjs'
import './git-e2e.test.mjs'
import './host-route.test.mjs'
import { cleanup as cleanupE2e } from './git-e2e.test.mjs'
import { cleanup as cleanupRoute } from './host-route.test.mjs'
import { run } from './harness.mjs'

await run()
await cleanupE2e()
await cleanupRoute()
