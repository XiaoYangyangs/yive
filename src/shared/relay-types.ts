import type { TeamListItemPayload, TerminalRunSummary } from './types.js'

export type RelayDeviceKind = 'desktop' | 'mobile'

export type RelayDesktopRuntimeStatus = 'offline' | 'online' | 'unknown'

export type RelayDesktopSupervisorStatus = 'error' | 'missing' | 'running' | 'stale'

export interface RelayDesktopDevice {
  connected_at?: number
  device_id: string
  features?: string[]
  last_seen_at?: number
  runtime_message?: string
  runtime_status?: RelayDesktopRuntimeStatus
  runtime_updated_at?: number
  supervisor_phase?: string
  supervisor_status?: RelayDesktopSupervisorStatus
  supervisor_updated_at?: number
}

export interface RelayMobileDevice {
  connected_at?: number
  desktop_id: string
  device_id: string
  last_seen_at?: number
}

export interface RelayDeviceSnapshot {
  desktops: RelayDesktopDevice[]
  mobiles: RelayMobileDevice[]
}

export interface RelayHealthSnapshot {
  desktop_count: number
  deployment?: {
    public_url_configured?: boolean
  }
  features?: string[]
  heartbeat_interval_ms?: number
  heartbeat_timeout_ms?: number
  mobile_count: number
  ok: true
  pairing_store?: {
    admin_token_default?: boolean
    device_token_count: number
    issued_token_count: number
    persistent: boolean
    require_desktop_binding?: boolean
  }
  protocol_version?: number
  service: string
  started_at?: number
  static?: {
    mobile_app_available: boolean
  }
  terminal_proxy_count?: number
  uptime_ms?: number
  version?: string
}

export interface RelayHubSnapshot {
  desktopCount: number
  desktops: RelayDesktopDevice[]
  mobileCount: number
  mobiles: RelayMobileDevice[]
  terminalProxyCount: number
}

export interface RelayPairingToken {
  expires_at?: number
  token: string
  ttl_ms?: number
}

export interface RelayClaimedDeviceToken {
  desktop_id?: string
  device_id: string
  device_kind?: RelayDeviceKind
  token: string
  workspace_ids?: string[]
}

export interface RelayAccountLoginResult {
  desktop_id: string
  device_id: string
  device_kind?: RelayDeviceKind
  token: string
  workspace_ids?: string[]
}

export interface RelayDeviceTokenSummary {
  desktop_id?: string
  device_id: string
  device_kind?: RelayDeviceKind
  token_hint: string
  workspace_ids?: string[]
}

export interface RelayAgentsAndRuns {
  agents: TeamListItemPayload[]
  runs: TerminalRunSummary[]
  workspace_id: string
}

export interface RelayMobileFileUpload {
  content_base64: string
  name: string
  workspace_id: string
}
