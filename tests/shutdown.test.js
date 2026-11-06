import test from 'node:test'
import assert from 'node:assert/strict'

import { createShutdownHandler } from '../lib/shutdown.js'

function createHarness({ closeMode = 'manual', timeoutMs = 1000 } = {}) {
  const events = []
  const logs = []
  let closeCallback = null
  let closeCount = 0

  const server = {
    close(callback) {
      closeCount += 1
      events.push('server.close')
      if (closeMode === 'throw') throw new Error('close failed')
      closeCallback = callback
      if (closeMode === 'callback') callback()
    },
    closeIdleConnections() {
      events.push('server.closeIdleConnections')
    },
    closeAllConnections() {
      events.push('server.closeAllConnections')
    },
  }

  const logger = {
    log(...args) { logs.push(args.join(' ')) },
    warn(...args) { logs.push(args.join(' ')) },
    error(...args) { logs.push(args.join(' ')) },
  }

  const shutdown = createShutdownHandler({
    server,
    closeDb() {
      events.push('closeDb')
    },
    beforeClose() {
      events.push('beforeClose')
    },
    timeoutMs,
    logger,
    exit(code) {
      events.push(`exit:${code}`)
    },
  })

  return {
    events,
    logs,
    shutdown,
    get closeCallback() { return closeCallback },
    get closeCount() { return closeCount },
  }
}

test('stops accepting connections before closing the database', () => {
  const harness = createHarness()

  assert.equal(harness.shutdown('SIGTERM'), true)
  assert.deepEqual(harness.events, [
    'beforeClose',
    'server.close',
    'server.closeIdleConnections',
  ])

  harness.closeCallback()
  assert.deepEqual(harness.events, [
    'beforeClose',
    'server.close',
    'server.closeIdleConnections',
    'closeDb',
    'exit:0',
  ])
})

test('ignores duplicate shutdown signals', () => {
  const harness = createHarness()

  assert.equal(harness.shutdown('SIGTERM'), true)
  assert.equal(harness.shutdown('SIGINT'), false)
  assert.equal(harness.closeCount, 1)

  harness.closeCallback()
  assert.equal(harness.events.filter((event) => event === 'closeDb').length, 1)
  assert.equal(harness.events.filter((event) => event === 'exit:0').length, 1)
  assert.equal(harness.logs.some((line) => line.includes('忽略重复')), true)
})

test('forces remaining connections closed after the timeout', async () => {
  const harness = createHarness({ timeoutMs: 20 })

  harness.shutdown('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 45))

  assert.deepEqual(harness.events, [
    'beforeClose',
    'server.close',
    'server.closeIdleConnections',
    'server.closeAllConnections',
    'closeDb',
    'exit:1',
  ])
})

test('closes the database and exits with failure when server.close reports an error', () => {
  const events = []
  let closeCallback = null
  const shutdown = createShutdownHandler({
    server: {
      close(callback) { closeCallback = callback },
      closeIdleConnections() {},
      closeAllConnections() {},
    },
    closeDb() { events.push('closeDb') },
    beforeClose() {},
    timeoutMs: 1000,
    logger: { log() {}, warn() {}, error() {} },
    exit(code) { events.push(`exit:${code}`) },
  })

  shutdown('SIGTERM')
  closeCallback(new Error('close failed'))

  assert.deepEqual(events, ['closeDb', 'exit:1'])
})

test('still closes the database when starting server.close throws', () => {
  const harness = createHarness({ closeMode: 'throw' })

  harness.shutdown('SIGTERM')

  assert.deepEqual(harness.events, [
    'beforeClose',
    'server.close',
    'closeDb',
    'exit:1',
  ])
})