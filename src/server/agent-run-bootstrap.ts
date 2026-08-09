import { delimiter, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import {
  buildAgentSessionDiscriminatorLabels,
  buildAgentSessionLabel,
} from './agent-session-label.js'
import {
  buildAgentLegacyIdentityMarker,
  buildAgentSessionBindingMarker,
} from './agent-startup-instructions.js'
import { getProviderAdapterForLaunchConfig } from './provider-adapter.js'
import { withProviderResumeArgs } from './provider-launch-support.js'
import {
  captureSessionIdForCapture,
  getSessionCaptureEnvironment,
  type SessionCaptureSnapshot,
  snapshotSessionIdsForCapture,
} from './session-capture.js'
import { buildYiveAgentNameContractLine } from './yive-startup-contract.js'

const resolveHiveBinDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(moduleDir, '../..')
  return moduleDir.includes(`${sep}dist${sep}src${sep}`)
    ? resolve(packageRoot, 'bin')
    : resolve(packageRoot, 'dist/bin')
}

const HIVE_BIN_DIR = resolveHiveBinDir()
const SESSION_CAPTURE_TIMEOUT_MS = 30_000

const createSessionCaptureDiscriminator = (
  workspace: WorkspaceSummary,
  agent: AgentIdentity | undefined
) => {
  if (!agent) return undefined
  return {
    contentIncludes: [
      buildAgentSessionBindingMarker({ agent, workspace }),
      buildAgentLegacyIdentityMarker({ agent, workspace }),
      ...buildAgentSessionDiscriminatorLabels({ agent, workspace }),
    ],
  }
}

const getExecutableName = (command: string) =>
  (command.split(/[\\/]/u).pop()?.toLowerCase() ?? command).replace(/\.(?:bat|cmd|exe)$/iu, '')

const hasClaudeNameArg = (args: string[]) =>
  args.some((arg) => arg === '--name' || arg === '-n' || arg.startsWith('--name='))

const withAgentSessionLabelArgs = (
  config: AgentLaunchConfigInput,
  workspace: WorkspaceSummary,
  agent: AgentIdentity | undefined
) => {
  if (!agent) return config
  if (getExecutableName(config.interactiveCommand ?? config.command) !== 'claude') return config
  const args = config.args ?? []
  if (hasClaudeNameArg(args)) return config
  return {
    ...config,
    args: ['--name', buildAgentSessionLabel({ agent, workspace }), ...args],
  }
}

export const buildAgentRunBootstrap = (
  workspace: WorkspaceSummary,
  agentId: string,
  config: AgentLaunchConfigInput,
  sessionStore: AgentSessionStorePort,
  agent?: AgentIdentity,
  nativeInstructions?: string
) => {
  const configuredAdapter = getProviderAdapterForLaunchConfig(config)
  const discriminator = configuredAdapter
    ? nativeInstructions && agent
      ? { contentIncludes: buildYiveAgentNameContractLine(agent) }
      : undefined
    : createSessionCaptureDiscriminator(workspace, agent)
  const resumedConfig = withProviderResumeArgs(
    config,
    sessionStore.getLastSessionId(workspace.id, agentId),
    workspace.path,
    discriminator,
    () => sessionStore.clearLastSessionId(workspace.id, agentId)
  )
  const sessionConfig = configuredAdapter
    ? resumedConfig
    : withAgentSessionLabelArgs(resumedConfig, workspace, agent)
  const providerAdapter = getProviderAdapterForLaunchConfig(sessionConfig) ?? configuredAdapter
  const launchInstructions = sessionConfig.resumedSessionId ? undefined : nativeInstructions
  const preparedStartConfig =
    providerAdapter && launchInstructions
      ? providerAdapter.prepareLaunch(sessionConfig, launchInstructions)
      : sessionConfig
  const captureSnapshot = snapshotSessionIdsForCapture(
    workspace.path,
    preparedStartConfig.sessionIdCapture,
    discriminator
  )
  const sessionCaptureSnapshot =
    captureSnapshot && preparedStartConfig.resumedSessionId
      ? { ...captureSnapshot, expectedSessionId: preparedStartConfig.resumedSessionId }
      : captureSnapshot
  const startEnv = {
    ...getSessionCaptureEnvironment(sessionCaptureSnapshot),
    CI: '1',
    HIVE_PORT: '',
    HIVE_PROJECT_ID: workspace.id,
    HIVE_AGENT_ID: agentId,
    HIVE_AGENT_TOKEN: '',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    PATH: `${HIVE_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`,
  }
  const startConfig =
    providerAdapter?.id ===
      getExecutableName(preparedStartConfig.interactiveCommand ?? preparedStartConfig.command) &&
    providerAdapter.prepareShellEnvironment
      ? providerAdapter.prepareShellEnvironment(preparedStartConfig, {
          ...process.env,
          ...startEnv,
        })
      : preparedStartConfig
  if (providerAdapter && nativeInstructions) {
    providerAdapter.assertCapabilities({
      command: startConfig.command,
      cwd: workspace.path,
      env: { ...process.env, ...startEnv },
      instructions: nativeInstructions,
    })
  }
  return {
    providerAdapter,
    sessionCaptureSnapshot,
    startConfig,
    startEnv,
  }
}

export const startAgentRunCapture = ({
  onSessionCaptured,
  sessionCaptureSnapshot,
  startConfig,
  workspace,
}: {
  onSessionCaptured?: (sessionId: string) => void
  sessionCaptureSnapshot: SessionCaptureSnapshot | undefined
  startConfig: AgentLaunchConfigInput
  workspace: WorkspaceSummary
}) => {
  if (!sessionCaptureSnapshot || !startConfig.sessionIdCapture) return
  void captureSessionIdForCapture(
    workspace.path,
    startConfig.sessionIdCapture,
    sessionCaptureSnapshot,
    (sessionId) => {
      onSessionCaptured?.(sessionId)
    },
    SESSION_CAPTURE_TIMEOUT_MS
  )
}
