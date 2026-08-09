import { describe, expect, test, vi } from 'vitest'

import { createRelayMobileRuntimeClient } from '../../web/src/mobile/mobile-runtime-client.js'

describe('mobile runtime client', () => {
  const createRelayClientMock = (overrides: Record<string, unknown> = {}) => ({
    clearMobileFiles: vi.fn(),
    createMobileConfirmation: vi.fn(),
    deleteMobileFile: vi.fn(),
    downloadMobileFile: vi.fn(),
    getMobileTranscript: vi.fn(),
    getMobileConversation: vi.fn(),
    getMobileConversations: vi.fn(),
    getMobileRecordedConversation: vi.fn(),
    listAgentsAndRuns: vi.fn(),
    listDispatches: vi.fn(),
    listMobileFiles: vi.fn(),
    listWorkspaces: vi.fn(),
    sendMobileAction: vi.fn(),
    sendWorkspaceFileToMobile: vi.fn(),
    subscribeMobileEvents: vi.fn(),
    uploadMobileFile: vi.fn(),
    ...overrides,
  })

  test('maps relay agents and runs into the mobile dashboard shape', async () => {
    const relayClient = createRelayClientMock({
      listAgentsAndRuns: vi.fn(async () => ({
        agents: [
          {
            active_dispatch_id: 'dispatch-1',
            conversation_activity: 'unknown' as const,
            provider: 'codex',
            conversation_provider: 'codex',
            id: 'agent-1',
            last_observed_at: 1_754_360_000_000,
            last_pty_line: 'ready',
            name: 'Coder',
            kind: 'worker' as const,
            process_state: 'crashed' as const,
            queue_pause_reason: 'worker_crashed',
            queued_dispatch_count: 2,
            runtime_context: { private_task: 'must not reach mobile dashboard state' },
            team_help: 'must not reach mobile dashboard state',
          },
        ],
        runs: [],
        workspace_id: 'workspace-1',
      })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.listDashboard('workspace-1')).resolves.toEqual({
      runs: [],
      workers: [
        {
          activeDispatchId: 'dispatch-1',
          conversationActivity: 'unknown',
          provider: 'codex',
          conversationProvider: 'codex',
          id: 'agent-1',
          lastObservedAt: 1_754_360_000_000,
          lastPtyLine: 'ready',
          name: 'Coder',
          kind: 'worker',
          processState: 'crashed',
          queuePauseReason: 'worker_crashed',
          queuedDispatchCount: 2,
        },
      ],
    })
    expect(relayClient.listAgentsAndRuns).toHaveBeenCalledWith('workspace-1')
  })

  test('sends terminal input through relay mobile_action', async () => {
    const relayClient = createRelayClientMock({
      sendMobileAction: vi.fn(async () => ({ ok: true })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await client.sendTerminalInput(
      'workspace-1',
      'run-1',
      'hello',
      [{ file_id: 'file-1', placeholder: '[Image #1]' }],
      'terminal-input-retry-1'
    )

    expect(relayClient.sendMobileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action_id: 'terminal-input-retry-1',
        artifact_contract_version: 2,
        kind: 'terminal_input',
        payload: {
          attachments: [{ file_id: 'file-1', placeholder: '[Image #1]' }],
          input: 'hello',
        },
        target: { run_id: 'run-1' },
        workspace_id: 'workspace-1',
      })
    )
  })

  test('sends file review decisions through relay mobile_action', async () => {
    const relayClient = createRelayClientMock({
      sendMobileAction: vi.fn(async () => ({
        result: {
          decision: 'approved',
          file_id: 'file-1',
          run_id: 'run-1',
        },
      })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(
      client.reviewFile('workspace-1', 'file-1', 'approved', {
        actionId: 'file-review-fixed',
        comment: 'Looks good.',
        runId: 'run-1',
      })
    ).resolves.toEqual({
      decision: 'approved',
      file_id: 'file-1',
      run_id: 'run-1',
    })

    expect(relayClient.sendMobileAction).toHaveBeenCalledWith({
      action_id: 'file-review-fixed',
      kind: 'file_review',
      payload: {
        comment: 'Looks good.',
        decision: 'approved',
      },
      target: { file_id: 'file-1', run_id: 'run-1' },
      workspace_id: 'workspace-1',
    })
    expect(JSON.stringify(relayClient.sendMobileAction.mock.calls)).not.toContain('local_path')
    expect(JSON.stringify(relayClient.sendMobileAction.mock.calls)).not.toContain('content_base64')
  })

  test('routes team actions through relay mobile_action without CLI agent tokens', async () => {
    const relayClient = createRelayClientMock({
      createMobileConfirmation: vi.fn(async () => ({ nonce: 'nonce-cancel' })),
      sendMobileAction: vi
        .fn()
        .mockResolvedValueOnce({ result: { dispatch_id: 'dispatch-1', to: 'Alice' } })
        .mockResolvedValueOnce({
          result: {
            created: true,
            delivery_state: 'queued',
            dispatch_id: 'dispatch-1',
            note_id: 'team-note-fixed',
          },
        })
        .mockResolvedValueOnce({
          result: {
            agent_id: 'agent-1',
            dispatch_id: 'dispatch-1',
            notify: true,
            request_id: 'team-status-fixed',
            updated_at: 100,
          },
        })
        .mockResolvedValueOnce({
          result: {
            agent_id: 'agent-1',
            dispatch_id: 'dispatch-1',
            outcome: 'failed',
            reported_at: 200,
            request_id: 'team-report-fixed',
          },
        })
        .mockResolvedValueOnce({
          result: { dispatch_id: 'dispatch-2', forwarded: false },
        })
        .mockResolvedValueOnce({
          result: {
            dispatch_id: 'dispatch-3',
            replaced_dispatch_id: 'dispatch-2',
            request_id: 'team-replace-fixed',
          },
        }),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(
      client.sendTeamTask('workspace-1', 'Alice', 'Check relay team path.', 'team-send-fixed')
    ).resolves.toEqual({ dispatch_id: 'dispatch-1', to: 'Alice' })
    await expect(
      client.sendTeamNote('workspace-1', 'dispatch-1', 'Supplemental context.', {
        actionId: 'team-note-fixed',
        artifacts: ['context.md'],
      })
    ).resolves.toEqual({
      created: true,
      delivery_state: 'queued',
      dispatch_id: 'dispatch-1',
      note_id: 'team-note-fixed',
    })
    await expect(
      client.sendTeamStatus('workspace-1', 'agent-1', 'Still working.', {
        actionId: 'team-status-fixed',
        artifacts: ['notes.md'],
        notify: true,
      })
    ).resolves.toEqual({
      agent_id: 'agent-1',
      dispatch_id: 'dispatch-1',
      notify: true,
      request_id: 'team-status-fixed',
      updated_at: 100,
    })
    await expect(
      client.sendTeamReport('workspace-1', 'agent-1', 'Done.', {
        actionId: 'team-report-fixed',
        artifacts: ['result.md'],
        outcome: 'failed',
      })
    ).resolves.toEqual({
      agent_id: 'agent-1',
      dispatch_id: 'dispatch-1',
      outcome: 'failed',
      reported_at: 200,
      request_id: 'team-report-fixed',
    })
    await expect(
      client.cancelTeamTask(
        'workspace-1',
        'dispatch-2',
        'Cancelled from phone.',
        'team-cancel-fixed'
      )
    ).resolves.toEqual({ dispatch_id: 'dispatch-2', forwarded: false })
    await expect(
      client.replaceTeamTask('workspace-1', 'dispatch-2', 'Corrected task.', {
        actionId: 'team-replace-fixed',
        artifacts: ['replacement.md'],
        interrupt: true,
      })
    ).resolves.toEqual({
      dispatch_id: 'dispatch-3',
      replaced_dispatch_id: 'dispatch-2',
      request_id: 'team-replace-fixed',
    })

    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(1, {
      action_id: 'team-send-fixed',
      kind: 'team_send',
      payload: { text: 'Check relay team path.' },
      target: { to: 'Alice' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(2, {
      action_id: 'team-note-fixed',
      kind: 'team_note',
      payload: { artifacts: ['context.md'], text: 'Supplemental context.' },
      target: { dispatch_id: 'dispatch-1' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        kind: 'team_status',
        action_id: 'team-status-fixed',
        payload: { artifacts: ['notes.md'], notify: true, text: 'Still working.' },
        target: { agent_id: 'agent-1' },
        workspace_id: 'workspace-1',
      })
    )
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(4, {
      action_id: 'team-report-fixed',
      kind: 'team_report',
      payload: { artifacts: ['result.md'], outcome: 'failed', text: 'Done.' },
      target: { agent_id: 'agent-1' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.createMobileConfirmation).toHaveBeenCalledWith({
      kind: 'team_cancel',
      target: { dispatch_id: 'dispatch-2' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(5, {
      action_id: 'team-cancel-fixed',
      kind: 'team_cancel',
      payload: { confirmation_nonce: 'nonce-cancel', reason: 'Cancelled from phone.' },
      target: { dispatch_id: 'dispatch-2' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.createMobileConfirmation).toHaveBeenCalledWith({
      kind: 'team_replace',
      target: { dispatch_id: 'dispatch-2' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(6, {
      action_id: 'team-replace-fixed',
      kind: 'team_replace',
      payload: {
        artifacts: ['replacement.md'],
        confirmation_nonce: 'nonce-cancel',
        interrupt: true,
        text: 'Corrected task.',
      },
      target: { dispatch_id: 'dispatch-2' },
      workspace_id: 'workspace-1',
    })
    expect(JSON.stringify(relayClient.sendMobileAction.mock.calls)).not.toContain('agent_token')
    expect(JSON.stringify(relayClient.sendMobileAction.mock.calls)).not.toContain(
      'HIVE_AGENT_TOKEN'
    )
  })

  test('loads mobile transcript through relay runtime client', async () => {
    const transcript = {
      attachments: [],
      events: [
        {
          bytes: 5,
          created_at: 1,
          id: 'action:terminal-input-1',
          kind: 'terminal_input' as const,
          type: 'mobile_action_echo' as const,
        },
      ],
      generated_at: 2,
      run: {
        agent_id: 'agent-1',
        agent_name: 'Coder',
        exit_code: null,
        status: 'running',
        terminal_input_profile: 'default' as const,
      },
      run_id: 'run-1',
      workspace_id: 'workspace-1',
    }
    const relayClient = createRelayClientMock({
      getMobileTranscript: vi.fn(async () => transcript),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.getTranscript('workspace-1', 'run-1')).resolves.toBe(transcript)
    expect(relayClient.getMobileTranscript).toHaveBeenCalledWith('workspace-1', 'run-1')
  })

  test('loads the current conversation through relay without changing public field names', async () => {
    const conversation = {
      agent_id: 'agent-1',
      cli_session_id: 'session-1',
      id: 'conversation-1',
      provider: 'codex' as const,
      recording_boundary: 10,
      source_checkpoint: 20,
      stale: false,
      submissions: [],
      turns: [{ provider_event_id: 'turn-1', role: 'assistant' as const, sequence: 1, text: 'hi' }],
      workspace_id: 'workspace-1',
    }
    const relayClient = createRelayClientMock({
      getMobileConversation: vi.fn(async () => ({ conversation })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.getCurrentConversation('workspace-1', 'agent-1')).resolves.toBe(
      conversation
    )
    expect(relayClient.getMobileConversation).toHaveBeenCalledWith('workspace-1', 'agent-1')
  })

  test('pages and dismisses recorded conversations through Relay without local projection data', async () => {
    const history = {
      items: [
        {
          active: false,
          cli_session_id: 'session-old',
          id: 'conversation-old',
          provider: 'codex' as const,
          started_at: 10,
          title: 'Old work',
        },
      ],
      next_cursor: 'next-page',
    }
    const relayClient = createRelayClientMock({
      getMobileConversations: vi.fn(async () => history),
      sendMobileAction: vi.fn(async () => ({ result: { dismissed: true } })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(
      client.listRecordedConversations('workspace-1', 'agent-1', 'cursor-1')
    ).resolves.toBe(history)
    await client.dismissRecordedConversation('workspace-1', 'agent-1', 'conversation-old')

    expect(relayClient.getMobileConversations).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'cursor-1'
    )
    expect(relayClient.sendMobileAction).toHaveBeenCalledWith({
      action_id: expect.any(String),
      kind: 'chat_dismiss_conversation',
      target: { agent_id: 'agent-1', conversation_id: 'conversation-old' },
      workspace_id: 'workspace-1',
    })
  })

  test('submits and manually retries Relay Chat with the same stable UUID', async () => {
    const delivered = {
      accepted_at: 1,
      attachments: [
        {
          file_id: 'file-1',
          mime_type: 'image/png',
          name: 'diagram.png',
          placeholder: '[Image 77777777 #1]',
          size: 8,
        },
      ],
      body: 'MOBILE_NORMAL_TURN',
      cancelled_at: null,
      confirmed_at: null,
      conversation_id: 'conversation-1',
      delivered_at: 2,
      error_code: null,
      id: '77777777-7777-4777-8777-777777777777',
      provider_event_id: null,
      provider_turn_sequence: null,
      state: 'delivered' as const,
    }
    const relayClient = createRelayClientMock({
      sendMobileAction: vi
        .fn()
        .mockRejectedValueOnce(new Error('acknowledgement lost'))
        .mockResolvedValueOnce({ result: delivered }),
    })
    const client = createRelayMobileRuntimeClient(relayClient)
    await expect(
      client.submitChatMessage(
        'workspace-1',
        'conversation-1',
        'MOBILE_NORMAL_TURN',
        delivered.id,
        [{ file_id: 'file-1' }]
      )
    ).rejects.toThrow('acknowledgement lost')
    await expect(
      client.submitChatMessage('workspace-1', 'conversation-1', undefined, delivered.id, [
        { file_id: 'file-1' },
      ])
    ).resolves.toEqual(delivered)
    expect(relayClient.sendMobileAction).toHaveBeenCalledTimes(2)
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(1, {
      action_id: delivered.id,
      kind: 'chat_submit',
      payload: { attachments: [{ file_id: 'file-1' }], body: 'MOBILE_NORMAL_TURN' },
      target: { conversation_id: 'conversation-1' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action_id: delivered.id,
        payload: { attachments: [{ file_id: 'file-1' }] },
      })
    )
    expect(JSON.stringify(relayClient.sendMobileAction.mock.calls[0])).not.toContain('team context')
    expect(JSON.stringify(relayClient.sendMobileAction.mock.calls[0])).not.toContain('reminder')
  })

  test('forces one Relay Chat queue entry with the confirmed skipped count', async () => {
    const forced = {
      accepted_at: 2,
      body: 'second',
      cancelled_at: null,
      confirmed_at: null,
      conversation_id: 'conversation-1',
      delivered_at: 3,
      error_code: null,
      id: '88888888-8888-4888-8888-888888888888',
      provider_event_id: null,
      provider_turn_sequence: null,
      state: 'delivered' as const,
    }
    const relayClient = createRelayClientMock({
      sendMobileAction: vi.fn(async () => ({ result: forced })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.forceChatSubmission('workspace-1', forced.id, 1)).resolves.toEqual(forced)
    expect(relayClient.sendMobileAction).toHaveBeenCalledWith({
      action_id: expect.any(String),
      kind: 'chat_force',
      payload: { skipped_count: 1 },
      target: { submission_id: forced.id },
      workspace_id: 'workspace-1',
    })
  })

  test('loads dispatches through relay runtime client', async () => {
    const dispatches = [
      {
        artifacts: [],
        created_at: 1,
        delivered_at: null,
        from_agent_id: 'workspace-1:orchestrator',
        id: 'dispatch-1',
        reported_at: null,
        report_text: null,
        state: 'queued' as const,
        submitted_at: null,
        text: 'Check mobile dispatches.',
        to_agent_id: 'agent-1',
        workspace_id: 'workspace-1',
      },
    ]
    const relayClient = createRelayClientMock({
      listDispatches: vi.fn(async () => dispatches),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.listDispatches('workspace-1')).resolves.toBe(dispatches)
    expect(relayClient.listDispatches).toHaveBeenCalledWith('workspace-1')
  })

  test('returns run ids from relay start and restart actions', async () => {
    const relayClient = createRelayClientMock({
      createMobileConfirmation: vi.fn(async () => ({ nonce: 'nonce-restart' })),
      sendMobileAction: vi
        .fn()
        .mockResolvedValueOnce({ result: { run_id: 'run-started' } })
        .mockResolvedValueOnce({ result: { run_id: 'run-restarted' } }),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.startAgentRun('workspace-1', 'agent-1')).resolves.toEqual({
      runId: 'run-started',
    })
    await expect(client.restartAgentRun('workspace-1', 'agent-1', 'run-old')).resolves.toEqual({
      runId: 'run-restarted',
    })
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'start_run',
        target: { agent_id: 'agent-1' },
        workspace_id: 'workspace-1',
      })
    )
    expect(relayClient.sendMobileAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'restart_run',
        payload: { confirmation_nonce: 'nonce-restart' },
        target: { agent_id: 'agent-1', run_id: 'run-old' },
        workspace_id: 'workspace-1',
      })
    )
  })

  test('requests a relay confirmation nonce before stopping a run', async () => {
    const relayClient = createRelayClientMock({
      createMobileConfirmation: vi.fn(async () => ({ nonce: 'nonce-stop' })),
      sendMobileAction: vi.fn(async () => ({ result: { run_id: 'run-1' } })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await client.stopAgentRun('workspace-1', 'run-1')

    expect(relayClient.createMobileConfirmation).toHaveBeenCalledWith({
      kind: 'stop_run',
      target: { run_id: 'run-1' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stop_run',
        payload: { confirmation_nonce: 'nonce-stop' },
        target: { run_id: 'run-1' },
        workspace_id: 'workspace-1',
      })
    )
  })

  test('preserves checkpoint stop mode and its structured Relay result', async () => {
    const relayClient = createRelayClientMock({
      createMobileConfirmation: vi.fn(async () => ({ nonce: 'nonce-checkpoint' })),
      sendMobileAction: vi.fn(async () => ({
        result: {
          mode: 'checkpoint',
          reason: null,
          run_id: 'run-1',
          session_id: 'session-1',
          state: 'stopped',
        },
      })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    const result = await client.stopAgentRun('workspace-1', 'run-1', 'checkpoint')

    expect(result).toEqual({
      mode: 'checkpoint',
      reason: null,
      run_id: 'run-1',
      session_id: 'session-1',
      state: 'stopped',
    })
    expect(relayClient.createMobileConfirmation).toHaveBeenCalledWith({
      kind: 'stop_run',
      target: { mode: 'checkpoint', run_id: 'run-1' },
      workspace_id: 'workspace-1',
    })
    expect(relayClient.sendMobileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stop_run',
        target: { mode: 'checkpoint', run_id: 'run-1' },
      })
    )
  })

  test('routes file exchange operations through relay client', async () => {
    const file = new File(['pixels'], 'shot.png', { type: 'image/png' })
    const relayClient = createRelayClientMock({
      clearMobileFiles: vi.fn(async () => undefined),
      deleteMobileFile: vi.fn(async () => undefined),
      downloadMobileFile: vi.fn(async () => ({
        content: new Blob(['pixels'], { type: 'image/png' }),
        mime_type: 'image/png',
        name: 'shot.png',
      })),
      listMobileFiles: vi.fn(async () => [
        {
          created_at: 1,
          id: 'file-1',
          mime_type: 'image/png',
          name: 'shot.png',
          size: 6,
        },
      ]),
      sendWorkspaceFileToMobile: vi.fn(async () => ({
        created_at: 2,
        id: 'file-2',
        mime_type: 'text/markdown',
        name: 'notes.md',
        size: 3,
      })),
      uploadMobileFile: vi.fn(async () => ({
        created_at: 1,
        id: 'file-1',
        mime_type: 'image/png',
        name: 'shot.png',
        size: 6,
      })),
    })
    const client = createRelayMobileRuntimeClient(relayClient)

    await expect(client.listFiles()).resolves.toEqual([
      {
        created_at: 1,
        id: 'file-1',
        mime_type: 'image/png',
        name: 'shot.png',
        size: 6,
      },
    ])
    await expect(client.uploadFile('workspace-1', file)).resolves.toEqual(
      expect.objectContaining({ id: 'file-1', name: 'shot.png' })
    )
    expect(relayClient.uploadMobileFile).toHaveBeenCalledWith({
      content_base64: 'cGl4ZWxz',
      name: 'shot.png',
      workspace_id: 'workspace-1',
    })
    await expect(client.sendWorkspaceFileToMobile('workspace-1', 'notes.md')).resolves.toEqual(
      expect.objectContaining({ id: 'file-2' })
    )
    await expect(client.downloadFile('file-1')).resolves.toEqual(
      expect.objectContaining({ name: 'shot.png' })
    )
    await expect(
      client.downloadChatAttachment('workspace-1', 'submission-1', 'file-1')
    ).resolves.toEqual(expect.objectContaining({ name: 'shot.png' }))
    expect(relayClient.downloadMobileFile).toHaveBeenLastCalledWith('file-1', undefined, {
      submissionId: 'submission-1',
      workspaceId: 'workspace-1',
    })
    await client.deleteFile('file-1')
    await client.clearFiles()
    expect(relayClient.deleteMobileFile).toHaveBeenCalledWith('file-1')
    expect(relayClient.clearMobileFiles).toHaveBeenCalled()
  })
})
