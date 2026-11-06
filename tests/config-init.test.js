import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfigFile } from '../lib/config.js'

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-config-'))
  t.after(() => {
    const resolved = path.resolve(dir)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(tempRoot)) throw new Error('临时目录清理路径越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return dir
}

test('creates config.json and a non-secret example when both files are missing', (t) => {
  const dir = createTempDir(t)
  const configFile = path.join(dir, 'config.json')
  const exampleFile = path.join(dir, 'config.example.json')

  const result = loadConfigFile({ configFile, exampleFile })

  assert.equal(result.justCreated, true)
  assert.match(result.registrationCode, /^VAULT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {
    registrationCode: result.registrationCode,
  })
  assert.deepEqual(JSON.parse(fs.readFileSync(exampleFile, 'utf8')), {
    registrationCode: 'VAULT-XXXX-XXXX-XXXX',
  })
  assert.notEqual(
    JSON.parse(fs.readFileSync(exampleFile, 'utf8')).registrationCode,
    result.registrationCode,
  )
})

test('reads and trims an existing registration code without creating a new one', (t) => {
  const dir = createTempDir(t)
  const configFile = path.join(dir, 'config.json')
  const exampleFile = path.join(dir, 'config.example.json')
  fs.writeFileSync(configFile, JSON.stringify({ registrationCode: '  test-code  ' }), 'utf8')

  const result = loadConfigFile({ configFile, exampleFile })

  assert.deepEqual(result, { registrationCode: 'test-code', justCreated: false })
  assert.equal(fs.existsSync(exampleFile), false)
})

test('rejects malformed config JSON without exposing its contents', (t) => {
  const dir = createTempDir(t)
  const configFile = path.join(dir, 'config.json')
  const exampleFile = path.join(dir, 'config.example.json')
  fs.writeFileSync(configFile, '{"registrationCode":"private-value"', 'utf8')
  const before = fs.readFileSync(configFile, 'utf8')

  assert.throws(
    () => loadConfigFile({ configFile, exampleFile }),
    (error) => error.message.includes('config.json 格式不正确')
      && !error.message.includes('private-value'),
  )
  assert.equal(fs.readFileSync(configFile, 'utf8'), before)
})