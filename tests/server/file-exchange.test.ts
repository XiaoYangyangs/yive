import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getMobileCookie, getUiCookie } from '../helpers/ui-session.js'

const upload = (baseUrl: string, cookie: string, input: { content: string; name: string }) =>
  fetch(`${baseUrl}/api/mobile/files`, {
    body: JSON.stringify({
      content_base64: Buffer.from(input.content).toString('base64'),
      name: input.name,
    }),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })

const uploadBuffer = (baseUrl: string, cookie: string, input: { content: Buffer; name: string }) =>
  fetch(`${baseUrl}/api/mobile/files`, {
    body: JSON.stringify({
      content_base64: input.content.toString('base64'),
      name: input.name,
    }),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })

const mp4Fixture = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42')])
const pngFixture = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')])

describe('mobile file exchange api', () => {
  test('requires a mobile session token', async () => {
    const server = await startTestServer()
    try {
      const response = await fetch(`${server.baseUrl}/api/mobile/files`)

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })
    } finally {
      await server.close()
    }
  })

  test('accepts mobile-token cookies without the UI cookie for file exchange', async () => {
    const server = await startTestServer()
    let cookie: string | undefined
    try {
      cookie = await getMobileCookie(server.baseUrl)

      const uploadResponse = await upload(server.baseUrl, cookie, {
        content: 'mobile token upload\n',
        name: 'mobile-token.md',
      })
      expect(uploadResponse.status).toBe(201)
      const item = (await uploadResponse.json()) as { id: string; name: string }
      expect(item.name).toBe('mobile-token.md')

      const listResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: { cookie },
      })
      await expect(listResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: item.id, name: 'mobile-token.md' }),
      ])
    } finally {
      if (cookie) {
        await fetch(`${server.baseUrl}/api/mobile/files`, {
          headers: { cookie },
          method: 'DELETE',
        })
      }
      await server.close()
    }
  })

  test('uploads, lists, downloads, deletes, and clears temporary files', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const uploadResponse = await upload(server.baseUrl, cookie, {
        content: '# Review\n',
        name: 'review.md',
      })
      expect(uploadResponse.status).toBe(201)
      const item = (await uploadResponse.json()) as { id: string; name: string; size: number }
      expect(item).toEqual(expect.objectContaining({ name: 'review.md', size: 9 }))

      const listResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: { cookie },
      })
      await expect(listResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: item.id, name: 'review.md', size: 9 }),
      ])

      const downloadResponse = await fetch(`${server.baseUrl}/api/mobile/files/${item.id}`, {
        headers: { cookie },
      })
      expect(downloadResponse.status).toBe(200)
      expect(downloadResponse.headers.get('content-type')).toContain('text/markdown')
      await expect(downloadResponse.text()).resolves.toBe('# Review\n')

      const deleteResponse = await fetch(`${server.baseUrl}/api/mobile/files/${item.id}`, {
        headers: { cookie },
        method: 'DELETE',
      })
      expect(deleteResponse.status).toBe(204)

      await upload(server.baseUrl, cookie, { content: 'again', name: 'again.md' })
      const clearResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: { cookie },
        method: 'DELETE',
      })
      expect(clearResponse.status).toBe(204)
      const emptyResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: { cookie },
      })
      await expect(emptyResponse.json()).resolves.toEqual([])
    } finally {
      await server.close()
    }
  })

  test('sanitizes uploaded file names before listing and download headers', async () => {
    const server = await startTestServer()
    let cookie: string | undefined
    try {
      cookie = await getUiCookie(server.baseUrl)

      const uploadResponse = await upload(server.baseUrl, cookie, {
        content: '# Safe\n',
        name: '..\\nested\\unsafe"name.md',
      })
      expect(uploadResponse.status).toBe(201)
      const item = (await uploadResponse.json()) as {
        id: string
        name: string
      }
      expect(item.name).toBe('unsafe_name.md')
      expect(item).not.toHaveProperty('local_path')
      expect(JSON.stringify(item)).not.toContain('nested')

      const listResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: { cookie },
      })
      await expect(listResponse.json()).resolves.toEqual([
        expect.objectContaining({
          id: item.id,
          name: 'unsafe_name.md',
        }),
      ])

      const downloadResponse = await fetch(`${server.baseUrl}/api/mobile/files/${item.id}`, {
        headers: { cookie },
      })
      expect(downloadResponse.status).toBe(200)
      expect(downloadResponse.headers.get('content-disposition')).toBe(
        'attachment; filename="unsafe_name.md"; filename*=UTF-8\'\'unsafe_name.md'
      )
    } finally {
      if (cookie) {
        await fetch(`${server.baseUrl}/api/mobile/files`, {
          headers: { cookie },
          method: 'DELETE',
        })
      }
      await server.close()
    }
  })

  test('expires temporary files after the exchange ttl', async () => {
    const now = 1_780_000_000_000
    const ttlMs = 24 * 60 * 60 * 1000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const uploadResponse = await upload(server.baseUrl, cookie, {
        content: 'temporary',
        name: 'temporary.log',
      })
      expect(uploadResponse.status).toBe(201)
      const item = (await uploadResponse.json()) as { expires_at: number; id: string }
      expect(item.expires_at).toBe(now + ttlMs)

      dateNow.mockReturnValue(now + ttlMs + 1)

      const listResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: { cookie },
      })
      await expect(listResponse.json()).resolves.toEqual([])

      const downloadResponse = await fetch(`${server.baseUrl}/api/mobile/files/${item.id}`, {
        headers: { cookie },
      })
      expect(downloadResponse.status).toBe(404)
    } finally {
      dateNow.mockRestore()
      await server.close()
    }
  })

  test('rejects unsupported extensions and missing downloads', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const uploadResponse = await upload(server.baseUrl, cookie, {
        content: 'bad',
        name: 'script.exe',
      })
      expect(uploadResponse.status).toBe(400)
      await expect(uploadResponse.json()).resolves.toEqual({
        error: 'Unsupported Artifact type: .exe',
      })

      const missingResponse = await fetch(`${server.baseUrl}/api/mobile/files/missing`, {
        headers: { cookie },
      })
      expect(missingResponse.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  test('accepts development artifacts for phone download', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const cases = [
        { content: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf', name: 'report.pdf' },
        { content: Buffer.from('PK\u0003\u0004'), mimeType: 'application/zip', name: 'bundle.zip' },
        { content: Buffer.from('run ok\n'), mimeType: 'text/plain', name: 'run.log' },
      ]

      for (const file of cases) {
        const uploadResponse = await uploadBuffer(server.baseUrl, cookie, {
          content: file.content,
          name: file.name,
        })
        expect(uploadResponse.status, file.name).toBe(201)
        const item = (await uploadResponse.json()) as {
          id: string
          mime_type: string
          name: string
        }
        expect(item).toEqual(
          expect.objectContaining({
            mime_type: expect.stringContaining(file.mimeType),
            name: file.name,
          })
        )

        const downloadResponse = await fetch(`${server.baseUrl}/api/mobile/files/${item.id}`, {
          headers: { cookie },
        })
        expect(downloadResponse.status, file.name).toBe(200)
        expect(downloadResponse.headers.get('content-type'), file.name).toContain(file.mimeType)
      }
    } finally {
      await server.close()
    }
  })

  test('rejects binary files whose content does not match their extension', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const cases = [
        { message: 'Artifact content does not match .png extension', name: 'fake.png' },
        { message: 'Artifact content does not match .jpg extension', name: 'fake.jpg' },
        { message: 'Artifact content does not match .webp extension', name: 'fake.webp' },
        { message: 'Artifact content does not match .pdf extension', name: 'fake.pdf' },
        { message: 'Artifact content does not match .zip extension', name: 'fake.zip' },
        { message: 'Artifact content does not match .mp4 extension', name: 'fake.mp4' },
      ]

      for (const file of cases) {
        const response = await upload(server.baseUrl, cookie, {
          content: 'MZ fake executable',
          name: file.name,
        })
        expect(response.status, file.name).toBe(400)
        await expect(response.json(), file.name).resolves.toEqual({ error: file.message })
      }
    } finally {
      await server.close()
    }
  })

  test('rejects files over the decoded 100MB limit', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const oversized = Buffer.alloc(100 * 1024 * 1024 + 1).toString('base64')

      const response = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({ content_base64: oversized, name: 'too-large.md' }),
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        method: 'POST',
      })

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual({ error: 'Artifact exceeds 100MB limit' })
    } finally {
      await server.close()
    }
  })

  test('uploads images as temporary local attachments and enforces the image size limit', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const uploadResponse = await uploadBuffer(server.baseUrl, cookie, {
        content: pngFixture(),
        name: 'photo.png',
      })
      expect(uploadResponse.status).toBe(201)
      const item = (await uploadResponse.json()) as {
        mime_type: string
        name: string
        size: number
      }
      expect(item).toEqual(
        expect.objectContaining({
          mime_type: 'image/png',
          name: 'photo.png',
          size: pngFixture().byteLength,
        })
      )
      expect(item).not.toHaveProperty('local_path')

      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
      const oversizedResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({ content_base64: oversized, name: 'too-large.png' }),
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        method: 'POST',
      })
      expect(oversizedResponse.status).toBe(413)
      await expect(oversizedResponse.json()).resolves.toEqual({
        error: 'Artifact image exceeds 10MB limit',
      })
    } finally {
      await server.close()
    }
  })

  test('rejects oversized base64 uploads before decoding the attachment body', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const oversizedPngBase64 = 'A'.repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4)

      const response = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({ content_base64: oversizedPngBase64, name: 'too-large.png' }),
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        method: 'POST',
      })

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual({
        error: 'Artifact image exceeds 10MB limit',
      })
    } finally {
      await server.close()
    }
  })

  test('copies a workspace file into the mobile download exchange', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-file-workspace-'))
    try {
      mkdirSync(join(workspacePath, 'dist'), { recursive: true })
      writeFileSync(join(workspacePath, 'dist', 'demo.mp4'), mp4Fixture())
      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspace = server.store.createWorkspace(workspacePath, 'Video Workspace')

        const response = await fetch(`${server.baseUrl}/api/mobile/files/from-workspace`, {
          body: JSON.stringify({ path: 'dist/demo.mp4', workspace_id: workspace.id }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        })
        expect(response.status).toBe(201)
        const item = (await response.json()) as {
          id: string
          mime_type: string
          name: string
          source: string
          workspace_path: string
        }
        expect(item).toEqual(
          expect.objectContaining({
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            source: 'workspace',
            workspace_path: 'dist/demo.mp4',
          })
        )
        expect(JSON.stringify(item)).not.toContain(workspacePath)

        const downloadResponse = await fetch(`${server.baseUrl}/api/mobile/files/${item.id}`, {
          headers: { cookie },
        })
        expect(downloadResponse.status).toBe(200)
        expect(downloadResponse.headers.get('content-type')).toContain('video/mp4')
        await expect(downloadResponse.arrayBuffer()).resolves.toEqual(
          expect.objectContaining({ byteLength: mp4Fixture().byteLength })
        )
      } finally {
        await server.close()
      }
    } finally {
      rmSync(workspacePath, { force: true, recursive: true })
    }
  })

  test('isolates Workspace-owned exchange items for selected mobile sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-file-scope-'))
    const workspaceAPath = join(root, 'workspace-a')
    const workspaceBPath = join(root, 'workspace-b')
    mkdirSync(workspaceAPath, { recursive: true })
    mkdirSync(workspaceBPath, { recursive: true })
    writeFileSync(join(workspaceAPath, 'a.md'), '# A\n')
    writeFileSync(join(workspaceBPath, 'b.md'), '# B\n')
    try {
      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspaceA = server.store.createWorkspace(workspaceAPath, 'Workspace A')
        const workspaceB = server.store.createWorkspace(workspaceBPath, 'Workspace B')
        const create = async (workspaceId: string, path: string) => {
          const response = await fetch(`${server.baseUrl}/api/mobile/files/from-workspace`, {
            body: JSON.stringify({ path, workspace_id: workspaceId }),
            headers: { 'content-type': 'application/json', cookie },
            method: 'POST',
          })
          expect(response.status).toBe(201)
          return (await response.json()) as { id: string; name: string }
        }
        const itemA = await create(workspaceA.id, 'a.md')
        const itemB = await create(workspaceB.id, 'b.md')
        const selectedHeaders = {
          cookie,
          'x-yive-mobile-workspace-ids': workspaceA.id,
        }

        const listResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
          headers: selectedHeaders,
        })
        const selectedItems = (await listResponse.json()) as Array<{ id: string; name: string }>
        expect(selectedItems).toContainEqual(
          expect.objectContaining({ id: itemA.id, name: 'a.md' })
        )
        expect(selectedItems).not.toContainEqual(expect.objectContaining({ id: itemB.id }))

        const deniedDownload = await fetch(`${server.baseUrl}/api/mobile/files/${itemB.id}`, {
          headers: selectedHeaders,
        })
        expect(deniedDownload.status).toBe(403)
        const deniedDelete = await fetch(`${server.baseUrl}/api/mobile/files/${itemB.id}`, {
          headers: selectedHeaders,
          method: 'DELETE',
        })
        expect(deniedDelete.status).toBe(403)

        const clearResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
          headers: selectedHeaders,
          method: 'DELETE',
        })
        expect(clearResponse.status).toBe(204)
        const remainingResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
          headers: { cookie },
        })
        const remainingItems = (await remainingResponse.json()) as Array<{
          id: string
          name: string
        }>
        expect(remainingItems).toContainEqual(
          expect.objectContaining({ id: itemB.id, name: 'b.md' })
        )
        expect(remainingItems).not.toContainEqual(expect.objectContaining({ id: itemA.id }))

        await fetch(`${server.baseUrl}/api/mobile/files`, {
          headers: { cookie },
          method: 'DELETE',
        })
      } finally {
        await server.close()
      }
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('assigns selected-scope uploads to their Workspace and rejects cross-scope reuse', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getMobileCookie(server.baseUrl)
      const workspaceAPath = join(server.dataDir, 'selected-a')
      const workspaceBPath = join(server.dataDir, 'selected-b')
      mkdirSync(workspaceAPath)
      mkdirSync(workspaceBPath)
      const workspaceA = server.store.createWorkspace(workspaceAPath, 'Selected A')
      const workspaceB = server.store.createWorkspace(workspaceBPath, 'Selected B')
      const selectedBHeaders = {
        'content-type': 'application/json',
        cookie,
        'x-yive-mobile-workspace-ids': workspaceB.id,
      }
      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: Buffer.from('# Owned by B\n').toString('base64'),
          name: 'owned-by-b.md',
        }),
        headers: selectedBHeaders,
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as { id: string }

      const selectedAHeaders = {
        cookie,
        'x-yive-mobile-workspace-ids': workspaceA.id,
      }
      const selectedAList = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: selectedAHeaders,
      })
      expect(await selectedAList.json()).not.toContainEqual(
        expect.objectContaining({ id: uploaded.id })
      )
      const selectedADownload = await fetch(`${server.baseUrl}/api/mobile/files/${uploaded.id}`, {
        headers: selectedAHeaders,
      })
      expect(selectedADownload.status).toBe(403)

      await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: selectedBHeaders,
        method: 'DELETE',
      })
    } finally {
      await server.close()
    }
  })

  test('rejects workspace file paths outside the workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-safe-workspace-'))
    const outsidePath = mkdtempSync(join(tmpdir(), 'hive-outside-workspace-'))
    try {
      writeFileSync(join(workspacePath, 'inside.mp4'), 'inside')
      writeFileSync(join(outsidePath, 'secret.mp4'), 'secret')
      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspace = server.store.createWorkspace(workspacePath, 'Safe Workspace')

        const traversalResponse = await fetch(`${server.baseUrl}/api/mobile/files/from-workspace`, {
          body: JSON.stringify({
            path: `../${basename(outsidePath)}/secret.mp4`,
            workspace_id: workspace.id,
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        })
        expect(traversalResponse.status).toBe(400)
        await expect(traversalResponse.json()).resolves.toEqual({
          error: 'Artifact references must stay inside the Workspace',
        })

        const absoluteResponse = await fetch(`${server.baseUrl}/api/mobile/files/from-workspace`, {
          body: JSON.stringify({
            path: join(outsidePath, 'secret.mp4'),
            workspace_id: workspace.id,
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        })
        expect(absoluteResponse.status).toBe(400)
        await expect(absoluteResponse.json()).resolves.toEqual({
          error: 'Artifact references must be Workspace-relative',
        })
      } finally {
        await server.close()
      }
    } finally {
      rmSync(workspacePath, { force: true, recursive: true })
      rmSync(outsidePath, { force: true, recursive: true })
    }
  })
})
