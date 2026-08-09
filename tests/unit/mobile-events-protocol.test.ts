import { describe, expect, test } from 'vitest'

import { parseMobileEventsServerMessage } from '../../src/shared/mobile-events.js'

describe('mobile events protocol', () => {
  test('parses mobile snapshot messages without browser APIs', () => {
    const message = parseMobileEventsServerMessage(
      JSON.stringify({
        snapshot: {
          active_workspace: null,
          active_workspace_id: 'workspace-1',
          connection: {
            auth: {
              http: 'mobile-token',
              websocket: 'mobile-token',
              workspace_scope: 'all',
            },
            health: {
              heartbeat_interval_ms: 15_000,
              stale_after_ms: 45_000,
              version_endpoint: '/api/version',
            },
            lan: {
              dev_lan_enabled: false,
              private_network_only: true,
              relay_enabled: true,
            },
            request: {
              host: 'relay.example',
              origin: 'https://relay.example',
              remote_address: '127.0.0.1',
            },
            websocket: {
              mobile_events_path: '/ws/mobile/events',
              terminal_control_path_template: '/ws/terminal/:runId/control',
              terminal_io_path_template: '/ws/terminal/:runId/io',
            },
          },
          generated_at: 1,
          workspaces: [{ id: 'workspace-1', name: 'Yive', path: '/workspace' }],
        },
        type: 'mobile-snapshot',
      })
    )

    expect(message).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({ active_workspace_id: 'workspace-1' }),
        type: 'mobile-snapshot',
      })
    )
  })

  test('parses heartbeat messages and ignores invalid payloads', () => {
    expect(parseMobileEventsServerMessage('{"generated_at":2,"type":"mobile-heartbeat"}')).toEqual({
      generated_at: 2,
      type: 'mobile-heartbeat',
    })
    expect(parseMobileEventsServerMessage('{bad json')).toBeNull()
    expect(parseMobileEventsServerMessage('{"type":"mobile-heartbeat"}')).toBeNull()
    expect(parseMobileEventsServerMessage('{"type":"unknown"}')).toBeNull()
  })

  test('parses lightweight conversation invalidations without accepting message bodies', () => {
    expect(
      parseMobileEventsServerMessage(
        JSON.stringify({
          activity_state: 'busy',
          agent_id: 'agent-1',
          conversation_id: 'conversation-1',
          cursor: 42,
          type: 'conversation-invalidated',
          workspace_id: 'workspace-1',
        })
      )
    ).toEqual({
      activity_state: 'busy',
      agent_id: 'agent-1',
      conversation_id: 'conversation-1',
      cursor: 42,
      type: 'conversation-invalidated',
      workspace_id: 'workspace-1',
    })
    expect(
      parseMobileEventsServerMessage(
        JSON.stringify({
          activity_state: 'idle',
          agent_id: 'agent-1',
          body: 'must not travel in an invalidation',
          conversation_id: 'conversation-1',
          cursor: 43,
          type: 'conversation-invalidated',
          workspace_id: 'workspace-1',
        })
      )
    ).toBeNull()
  })
})
