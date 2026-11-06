import test from 'node:test'
import assert from 'node:assert/strict'

import { createTrashSweeper } from '../lib/trash-sweeper.js'

test('purges expired records only after disk removal succeeds', () => {
  const purged = []
  const sweeper = createTrashSweeper({
    listExpiredFiles: () => [
      { id: 'ok', ownerId: 'u1' },
      { id: 'fail', ownerId: 'u1' },
    ],
    removeStoredFile: (record) => record.id === 'ok',
    purgeFile: (id, ownerId) => { purged.push([id, ownerId]); return true },
    cleanupExpiredUploadSessions: () => 0,
    trashTtlMs: 1000,
    intervalMs: 60_000,
    logger: { log() {}, error() {} },
  })
  const timer = sweeper()
  clearInterval(timer)
  assert.deepEqual(purged, [['ok', 'u1']])
})