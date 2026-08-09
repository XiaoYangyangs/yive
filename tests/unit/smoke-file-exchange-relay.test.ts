import { describe, expect, test } from 'vitest'

import { runRelayFileExchangeSmoke } from '../../deploy/smoke-file-exchange-relay.mjs'

class FakeSocket {
  static OPEN = 1
  on = () => this
  once = (event: string, handler: () => void) => {
    if (event === 'open') queueMicrotask(handler)
    return this
  }
  off = () => this
  closeCalls: Array<{ code: number; reason: string }> = []
  send = () => {}

  close(code = 1000, reason = '') {
    this.closeCalls.push({ code, reason })
  }
}

describe('smoke-file-exchange-relay', () => {
  test('cleans up only files created by the smoke run', async () => {
    const requests: Array<{ payload: unknown; type: string }> = []
    let socketUrl = ''
    const socket = new FakeSocket()

    const result = await runRelayFileExchangeSmoke(
      [
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--workspace-id',
        'workspace-1',
        '--workspace-file',
        'README.md',
      ],
      {
        now: () => new Date('2026-06-11T12:00:00.000Z'),
        request: async ({ payload, type }: { payload: unknown; type: string }) => {
          requests.push({ payload, type })
          if (type === 'upload_mobile_file') {
            return {
              created_at: 1,
              id: 'uploaded-file',
              mime_type: 'text/markdown; charset=utf-8',
              name: 'relay-smoke.md',
              size: 52,
            }
          }
          if (type === 'list_mobile_files') {
            return [{ id: 'uploaded-file', name: 'relay-smoke.md' }]
          }
          if (type === 'download_mobile_file') {
            return {
              content_base64: Buffer.from(
                'Yive relay file exchange smoke 2026-06-11T12:00:00.000Z\n',
                'utf8'
              ).toString('base64'),
              mime_type: 'text/markdown; charset=utf-8',
              name: 'relay-smoke.md',
            }
          }
          if (type === 'send_workspace_file_to_mobile') {
            return {
              created_at: 2,
              id: 'workspace-file',
              mime_type: 'text/markdown; charset=utf-8',
              name: 'README.md',
              size: 128,
            }
          }
          if (type === 'delete_mobile_file') return { ok: true }
          throw new Error(`Unexpected request type ${type}`)
        },
        socketFactory: (url: string) => {
          socketUrl = url
          return socket
        },
      }
    )

    const url = new URL(socketUrl)
    expect(url.origin).toBe('wss://relay.example')
    expect(url.pathname).toBe('/ws/mobile')
    expect(url.searchParams.get('desktop_id')).toBe('desktop-1')
    expect(url.searchParams.get('pairing_token')).toBe('secret-token')
    expect(url.searchParams.get('device_id')).toMatch(/^smoke-file-/u)
    expect(result.uploaded.id).toBe('uploaded-file')
    expect(result.workspaceItem?.id).toBe('workspace-file')
    expect(requests.map((item) => item.type)).toEqual([
      'upload_mobile_file',
      'list_mobile_files',
      'download_mobile_file',
      'send_workspace_file_to_mobile',
      'delete_mobile_file',
      'delete_mobile_file',
    ])
    expect(requests).not.toContainEqual(expect.objectContaining({ type: 'clear_mobile_files' }))
    expect(requests.slice(-2).map((item) => item.payload)).toEqual([
      { file_id: 'uploaded-file' },
      { file_id: 'workspace-file' },
    ])
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'file exchange smoke complete' }])
  })

  test('can verify Relay-safe image paste through the paired desktop runtime', async () => {
    const requests: Array<{ payload: unknown; type: string }> = []
    const socket = new FakeSocket()

    const result = await runRelayFileExchangeSmoke(
      [
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--workspace-id',
        'workspace-1',
        '--run-id',
        'run-1',
        '--verify-image-paste',
      ],
      {
        now: () => new Date('2026-06-11T12:00:00.000Z'),
        request: async ({ payload, type }: { payload: unknown; type: string }) => {
          requests.push({ payload, type })
          if (type === 'upload_mobile_file') {
            const name =
              typeof payload === 'object' && payload !== null && 'name' in payload
                ? String((payload as { name?: unknown }).name)
                : ''
            return {
              created_at: name.endsWith('.png') ? 2 : 1,
              id: name.endsWith('.png') ? 'image-file' : 'uploaded-file',
              mime_type: name.endsWith('.png') ? 'image/png' : 'text/markdown; charset=utf-8',
              name,
              size: name.endsWith('.png') ? 11 : 52,
            }
          }
          if (type === 'list_mobile_files') {
            return [{ id: 'uploaded-file', name: 'relay-smoke.md' }]
          }
          if (type === 'download_mobile_file') {
            return {
              content_base64: Buffer.from(
                'Yive relay file exchange smoke 2026-06-11T12:00:00.000Z\n',
                'utf8'
              ).toString('base64'),
              mime_type: 'text/markdown; charset=utf-8',
              name: 'relay-smoke.md',
            }
          }
          if (type === 'mobile_action') {
            return {
              action_id: 'smoke-image-paste-1',
              kind: 'native_image_paste',
              ok: true,
              result: {
                attachment: {
                  artifact: '.hive/chat-attachments/smoke-image-paste-1/image-file.png',
                  file_id: 'image-file',
                  placeholder: '[Image #1]',
                },
                input: 'server_attachment_prompt',
                run_id: 'run-1',
              },
              workspace_id: 'workspace-1',
            }
          }
          if (type === 'delete_mobile_file') return { ok: true }
          throw new Error(`Unexpected request type ${type}`)
        },
        socketFactory: () => socket,
      }
    )

    expect(result.imagePaste).toEqual({
      file: {
        id: 'image-file',
        mimeType: 'image/png',
        name: 'relay-smoke-image.png',
        size: 11,
      },
      input: 'server_attachment_prompt',
    })
    expect(requests.map((item) => item.type)).toEqual([
      'upload_mobile_file',
      'list_mobile_files',
      'download_mobile_file',
      'upload_mobile_file',
      'mobile_action',
      'delete_mobile_file',
      'delete_mobile_file',
    ])
    expect(requests[4]?.payload).toMatchObject({
      artifact_contract_version: 2,
      kind: 'native_image_paste',
      payload: { file_id: 'image-file', placeholder: '[Image #1]' },
      target: { run_id: 'run-1' },
      workspace_id: 'workspace-1',
    })
    expect(requests.slice(-2).map((item) => item.payload)).toEqual([
      { file_id: 'uploaded-file' },
      { file_id: 'image-file' },
    ])
  })

  test('rejects Relay file exchange responses with path-like file names', async () => {
    const socket = new FakeSocket()

    await expect(
      runRelayFileExchangeSmoke(
        [
          '--server',
          'https://relay.example',
          '--token',
          'secret-token',
          '--desktop-id',
          'desktop-1',
        ],
        {
          now: () => new Date('2026-06-11T12:00:00.000Z'),
          request: async ({ type }: { type: string }) => {
            if (type === 'upload_mobile_file') {
              return {
                created_at: 1,
                id: 'uploaded-file',
                mime_type: 'text/markdown; charset=utf-8',
                name: 'C:\\Temp\\relay-smoke.md',
                size: 52,
              }
            }
            if (type === 'delete_mobile_file') return { ok: true }
            throw new Error(`Unexpected request type ${type}`)
          },
          socketFactory: () => socket,
        }
      )
    ).rejects.toThrow('upload_mobile_file.name must be a file name, not a path')
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'file exchange smoke complete' }])
  })

  test('requires workspace id and run id when verifying image paste', async () => {
    await expect(
      runRelayFileExchangeSmoke([
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--verify-image-paste',
      ])
    ).rejects.toThrow('--verify-image-paste requires --workspace-id and --run-id')
  })
})
