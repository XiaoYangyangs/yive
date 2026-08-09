import { mkdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { MAX_ARTIFACT_BYTES } from '../../src/server/artifact-reference.js'
import { startTestServer } from '../helpers/test-server.js'
import { getMobileCookie } from '../helpers/ui-session.js'

const startIdentity = async (
  server: Awaited<ReturnType<typeof startTestServer>>,
  workspaceId: string,
  agentId: string
) => {
  server.store.configureAgentLaunch(workspaceId, agentId, {
    args: ['-e', 'process.stdin.resume()'],
    command: process.execPath,
    provider: 'codex',
  })
  await server.store.startAgent(workspaceId, agentId, {
    hivePort: server.baseUrl.split(':').at(-1) ?? '',
    suppressStartupInstructions: true,
  })
  const token = server.store.peekAgentToken(agentId)
  if (!token) throw new Error(`Missing Agent token: ${agentId}`)
  return token
}

const headersFor = (agentId: string, token: string) => ({
  'content-type': 'application/json',
  'x-hive-agent-id': agentId,
  'x-hive-agent-token': token,
})

describe('Agent-facing mobile tools', () => {
  test('generates role-aware Help and enforces Worker notification denial server-side', async () => {
    const server = await startTestServer()
    try {
      const workspacePath = join(server.dataDir, 'workspace')
      mkdirSync(workspacePath, { recursive: true })
      const workspace = server.store.createWorkspace(workspacePath, 'Agent Tools')
      const orchestratorId = `${workspace.id}:orchestrator`
      const worker = server.store.addWorker(workspace.id, { name: 'Builder' })
      const orchestratorToken = await startIdentity(server, workspace.id, orchestratorId)
      const workerToken = await startIdentity(server, workspace.id, worker.id)

      const orchestratorHelp = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agent/help`,
        { headers: headersFor(orchestratorId, orchestratorToken) }
      )
      const workerHelp = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agent/help`,
        {
          headers: headersFor(worker.id, workerToken),
        }
      )
      const orchestratorText = String(((await orchestratorHelp.json()) as { help: string }).help)
      const workerText = String(((await workerHelp.json()) as { help: string }).help)
      expect(orchestratorText).toContain('notify')
      expect(orchestratorText).toContain('send-file')
      expect(workerText).toContain('send-file')
      expect(workerText).not.toContain('notify')
      expect(`${orchestratorText}\n${workerText}`).not.toMatch(/\b(lan|relay|pairing|runtime)\b/iu)

      const denied = await fetch(`${server.baseUrl}/api/agent/notify`, {
        body: JSON.stringify({ body: 'No', title: 'Denied', workspace_id: workspace.id }),
        headers: headersFor(worker.id, workerToken),
        method: 'POST',
      })
      expect(denied.status).toBe(403)
      await expect(denied.json()).resolves.toMatchObject({ code: 'agent_tool_forbidden' })
      expect(server.store.listMobileNotifications()).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('sends a normalized Artifact for either role and notifies only as the Orchestrator', async () => {
    const server = await startTestServer()
    try {
      const workspacePath = join(server.dataDir, 'workspace')
      mkdirSync(join(workspacePath, 'dist'), { recursive: true })
      writeFileSync(join(workspacePath, 'dist', 'report.md'), '# Report\n')
      writeFileSync(
        join(workspacePath, 'dist', 'preview.png'),
        Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('preview')])
      )
      writeFileSync(join(workspacePath, 'run.exe'), 'not executable')
      writeFileSync(join(workspacePath, 'fake.png'), 'not a png')
      const oversized = join(workspacePath, 'oversized.log')
      writeFileSync(oversized, '')
      truncateSync(oversized, MAX_ARTIFACT_BYTES + 1)
      const outsideDirectory = join(server.dataDir, 'outside-artifacts')
      mkdirSync(outsideDirectory)
      writeFileSync(join(outsideDirectory, 'secret.md'), '# Outside\n')
      const linkedDirectory = join(workspacePath, 'linked')
      symlinkSync(outsideDirectory, linkedDirectory, 'junction')
      const workspace = server.store.createWorkspace(workspacePath, 'Agent Tools')
      const orchestratorId = `${workspace.id}:orchestrator`
      const worker = server.store.addWorker(workspace.id, { name: 'Builder' })
      const orchestratorToken = await startIdentity(server, workspace.id, orchestratorId)
      const workerToken = await startIdentity(server, workspace.id, worker.id)

      try {
        for (const unsafePath of [
          '../outside-artifacts/secret.md',
          join(workspacePath, 'dist', 'report.md'),
          'safe/../dist/report.md',
          'linked/secret.md',
          'missing.md',
          'run.exe',
          'fake.png',
          'oversized.log',
        ]) {
          const rejected = await fetch(`${server.baseUrl}/api/agent/send-file`, {
            body: JSON.stringify({ path: unsafePath, workspace_id: workspace.id }),
            headers: headersFor(worker.id, workerToken),
            method: 'POST',
          })
          expect([400, 413], unsafePath).toContain(rejected.status)
          const rejectedText = await rejected.text()
          expect(rejectedText).not.toContain(workspacePath)
          expect(rejectedText).not.toContain(workerToken)
        }
      } finally {
        unlinkSync(linkedDirectory)
      }

      const sent = await fetch(`${server.baseUrl}/api/agent/send-file`, {
        body: JSON.stringify({ path: 'dist\\.\\report.md', workspace_id: workspace.id }),
        headers: headersFor(worker.id, workerToken),
        method: 'POST',
      })
      expect(sent.status).toBe(201)
      const sentText = await sent.text()
      expect(JSON.parse(sentText)).toEqual({
        artifact: 'dist/report.md',
        name: 'report.md',
        ok: true,
        size: 9,
      })
      expect(sentText).not.toContain(workspace.id)
      expect(sentText).not.toContain(worker.id)
      expect(sentText).not.toContain(workerToken)
      expect(sentText).not.toContain(workspacePath)

      const otherWorkspacePath = join(server.dataDir, 'other-workspace')
      mkdirSync(otherWorkspacePath)
      const otherWorkspace = server.store.createWorkspace(otherWorkspacePath, 'Other Workspace')
      const mobileCookie = await getMobileCookie(server.baseUrl)
      const selectedList = await fetch(`${server.baseUrl}/api/mobile/files`, {
        headers: {
          cookie: mobileCookie,
          'x-yive-mobile-workspace-ids': otherWorkspace.id,
        },
      })
      expect(await selectedList.json()).not.toContainEqual(
        expect.objectContaining({ name: 'report.md' })
      )

      const notified = await fetch(`${server.baseUrl}/api/agent/notify`, {
        body: JSON.stringify({
          body: 'Preview ready',
          image_path: 'dist/preview.png',
          title: 'Build done',
          workspace_id: workspace.id,
        }),
        headers: headersFor(orchestratorId, orchestratorToken),
        method: 'POST',
      })
      expect(notified.status).toBe(201)
      const notificationText = await notified.text()
      expect(JSON.parse(notificationText)).toMatchObject({
        image_artifact: 'dist/preview.png',
        ok: true,
        title: 'Build done',
      })
      expect(notificationText).not.toContain(workspace.id)
      expect(notificationText).not.toContain(orchestratorId)
      expect(notificationText).not.toContain(orchestratorToken)
      expect(notificationText).not.toContain(workspacePath)
      expect(server.store.listMobileNotifications()).toHaveLength(1)

      const listWorkspaces = vi.spyOn(server.store, 'listWorkspaces').mockImplementation(() => {
        throw new Error(`read failed at ${join(workspacePath, 'dist', 'report.md')}`)
      })
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const failedTransfer = await fetch(`${server.baseUrl}/api/agent/send-file`, {
        body: JSON.stringify({ path: 'dist/report.md', workspace_id: workspace.id }),
        headers: headersFor(worker.id, workerToken),
        method: 'POST',
      })
      listWorkspaces.mockRestore()
      expect(failedTransfer.status).toBe(500)
      const failedTransferText = await failedTransfer.text()
      expect(failedTransferText).toContain('Internal server error')
      expect(failedTransferText).not.toContain(workspacePath)
      const loggedError = errorLog.mock.calls.flat().join('\n')
      errorLog.mockRestore()
      expect(loggedError).toContain('read failed at [local path]')
      expect(loggedError).not.toContain(workspacePath)
      expect(loggedError).not.toContain(workerToken)
    } finally {
      await server.close()
    }
  })
})
