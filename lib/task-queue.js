/**
 * 有界并发任务队列，并按 key 去重。
 *
 * @param {{concurrency?: number}} options
 * @returns {{enqueue: (key: string, task: () => Promise<any>) => Promise<any>}}
 */
export function createTaskQueue({ concurrency = 1 } = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1))
  const pending = []
  const active = new Map()
  let running = 0

  const pump = () => {
    while (running < limit && pending.length) {
      const job = pending.shift()
      running += 1
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          running -= 1
          active.delete(job.key)
          pump()
        })
    }
  }

  const enqueue = (key, task) => {
    if (active.has(key)) return active.get(key)
    let resolveJob
    let rejectJob
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve
      rejectJob = reject
    })
    active.set(key, promise)
    pending.push({ key, task, resolve: resolveJob, reject: rejectJob })
    pump()
    return promise
  }

  return { enqueue }
}