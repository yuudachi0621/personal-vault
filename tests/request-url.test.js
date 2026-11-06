import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { parseRequestUrl } from '../lib/request-url.js'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function sendRaw(port, request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(request)
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

test('parses path and query without using Host', () => {
  const url = parseRequestUrl('/api/files?sort=newest&limit=30')

  assert.ok(url)
  assert.equal(url.pathname, '/api/files')
  assert.equal(url.searchParams.get('sort'), 'newest')
  assert.equal(url.searchParams.get('limit'), '30')
})

test('uses root path when request target is empty', () => {
  const url = parseRequestUrl('')

  assert.ok(url)
  assert.equal(url.pathname, '/')
})

test('returns null for malformed request target', () => {
  assert.equal(parseRequestUrl('http://['), null)
})

test('an invalid Host does not break request URL parsing', async () => {
  const server = http.createServer((req, res) => {
    const url = parseRequestUrl(req.url)
    assert.ok(url)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ pathname: url.pathname }))
  })

  const port = await listen(server)
  try {
    const response = await sendRaw(
      port,
      'GET /api/health?probe=1 HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n',
    )

    assert.match(response, /^HTTP\/1\.1 200 /)
    assert.match(response, /\{"pathname":"\/api\/health"\}/)
  } finally {
    await close(server)
  }
})
