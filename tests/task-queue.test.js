import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskQueue } from '../lib/task-queue.js'

test('deduplicates tasks with the same key while active', async () => {
  const queue = createTaskQueue()
  let runs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })

  const first = queue.enqueue('same', async () => {
    runs += 1
    await gate
    return 'done'
  })
  const second = queue.enqueue('same', async () => {
    runs += 1
    return 'duplicate'
  })

  assert.equal(first, second)
  release()
  assert.equal(await first, 'done')
  assert.equal(runs, 1)
})

test('never exceeds the configured concurrency', async () => {
  const queue = createTaskQueue({ concurrency: 2 })
  let active = 0
  let maximum = 0

  const tasks = Array.from({ length: 6 }, (_, index) => queue.enqueue(`task-${index}`, async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return index
  }))

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5])
  assert.equal(maximum, 2)
})

test('allows a key to be queued again after a rejected task', async () => {
  const queue = createTaskQueue()
  await assert.rejects(
    queue.enqueue('retry', async () => { throw new Error('first failed') }),
    /first failed/,
  )
  assert.equal(await queue.enqueue('retry', async () => 42), 42)
})