/** Minimal assertion harness: no test framework exists in this runtime. */
import assert from 'node:assert/strict'

/** Registered cases, in declaration order. */
const cases = []

/**
 * Register one case.
 * @param name - what the case proves.
 * @param fn - the case body; throwing fails it.
 */
export function test(name, fn) {
  cases.push({ name, fn })
}

/** Run every registered case and report one line each. */
export async function run() {
  let failed = 0
  for (const item of cases) {
    try {
      await item.fn()
      console.log(`ok   ${item.name}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL ${item.name}`)
      console.error(`     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : String(error)}`)
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`)
  if (failed > 0) process.exitCode = 1
}

export { assert }
