import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDb, initializeDatabase } from '../lib/db.js'
import { createFolder, moveFolder, listFolders, folderBreadcrumbs, getFolderTree, softDeleteFolderTree, listTrashFolders, listTrashFiles, restoreFolderTree, purgeFolderTree } from '../lib/folder-store.js'
import { createFile, usageFor } from '../lib/store.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-folders-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('creates nested folders, recursively deletes/restores and purges them', async (t) => {
  const dataDir = tempDir(t)
  await initializeDatabase({ dataDir, uploadDir: path.join(dataDir, 'uploads'), dbFile: path.join(dataDir, 'vault.db') })
  try {
    const { db } = await import('../lib/db.js')
    db.prepare('INSERT INTO users (id, email, nickname, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u1', 'folder@example.com', 'Folder', 'salt', 'hash', '2026-01-01T00:00:00.000Z')
    const now = new Date().toISOString()
    const root = createFolder({ id: 'f1', ownerId: 'u1', parentId: null, name: '资料', createdAt: now, updatedAt: now })
    const child = createFolder({ id: 'f2', ownerId: 'u1', parentId: root.id, name: '子目录', createdAt: now, updatedAt: now })
    createFile({ id: 'x1', ownerId: 'u1', name: 'a.txt', category: 'file', mime: 'text/plain', contentHash: 'h1', size: 3, storedName: 'x1.txt', createdAt: now, updatedAt: now, folderId: child.id })
    createFile({ id: 'x2', ownerId: 'u1', name: 'b.txt', category: 'file', mime: 'text/plain', contentHash: 'h2', size: 4, storedName: 'x2.txt', createdAt: now, updatedAt: now, folderId: child.id })

    assert.deepEqual(listFolders({ ownerId: 'u1', parentId: null }).map((folder) => folder.name), ['资料'])
    assert.deepEqual(folderBreadcrumbs(child.id, 'u1').map((folder) => folder.name), ['资料', '子目录'])
    const tree = getFolderTree('u1', root.id)
    assert.equal(tree.folders.length, 2)
    assert.equal(tree.files.length, 2)
    assert.equal(usageFor('u1').foldersTotal, 2)

    const deletedAt = '2026-01-02T00:00:00.000Z'
    assert.ok(softDeleteFolderTree(root.id, 'u1', deletedAt))
    assert.deepEqual(listTrashFolders('u1').map((folder) => folder.name), ['资料'])
    assert.equal(listTrashFiles('u1').length, 0)

    assert.ok(restoreFolderTree(root.id, 'u1'))
    assert.equal(getFolderTree('u1', root.id).files.length, 2)

    assert.ok(softDeleteFolderTree(root.id, 'u1', deletedAt))
    assert.equal(purgeFolderTree(root.id, 'u1'), true)
    assert.deepEqual(listFolders({ ownerId: 'u1', parentId: null }), [])
  } finally {
    closeDb()
  }
})
test('moves folders while rejecting self, descendant and duplicate-name targets', async (t) => {
  const dataDir = tempDir(t)
  await initializeDatabase({ dataDir, uploadDir: path.join(dataDir, 'uploads'), dbFile: path.join(dataDir, 'vault.db') })
  try {
    const { db } = await import('../lib/db.js')
    db.prepare('INSERT INTO users (id, email, nickname, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u_move', 'move@example.com', 'Move', 'salt', 'hash', '2026-01-01T00:00:00.000Z')
    const now = '2026-01-01T00:00:00.000Z'
    createFolder({ id: 'root-a', ownerId: 'u_move', parentId: null, name: 'A', createdAt: now, updatedAt: now })
    createFolder({ id: 'root-b', ownerId: 'u_move', parentId: null, name: 'B', createdAt: now, updatedAt: now })
    createFolder({ id: 'child-a', ownerId: 'u_move', parentId: 'root-a', name: 'Child', createdAt: now, updatedAt: now })

    assert.equal(moveFolder('root-b', 'u_move', 'root-a').parentId, 'root-a')
    assert.throws(() => moveFolder('root-a', 'u_move', 'root-a'), (error) => error.code === 'FOLDER_CYCLE')
    assert.throws(() => moveFolder('root-a', 'u_move', 'child-a'), (error) => error.code === 'FOLDER_CYCLE')

    createFolder({ id: 'root-b-copy', ownerId: 'u_move', parentId: null, name: 'B', createdAt: now, updatedAt: now })
    assert.throws(() => moveFolder('root-b-copy', 'u_move', 'root-a'), (error) => error.code === 'FOLDER_EXISTS')
    assert.throws(() => moveFolder('root-b', 'u_move', 'missing-folder'), (error) => error.code === 'FOLDER_NOT_FOUND')
  } finally {
    closeDb()
  }
})