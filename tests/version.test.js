import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { getAppVersion } from '../lib/version.js'

test('reads the application version from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(getAppVersion(), pkg.version)
  assert.equal(getAppVersion(), getAppVersion())
})