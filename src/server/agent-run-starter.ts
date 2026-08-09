import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import { buildAgentRunBootstrap, startAgentRunCapture } from './agent-run-bootstrap.js'
import { handleAgentRunExit } from './agent-run-exit-handler.js'
import type {
  AgentRunExitContext,
  AgentRunStarterStorePort,
  PersistAgentRunExit,
} from './agent-run-start-context.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import {
  createPostStartInputWriterAsync,
  hasInteractivePromptReady,
} from './post-start-input-writer.js'
import type { RestartPolicy } from './restart-policy.js'
import {
  resolvePromptReadyResumeVerification,
  watchSessionVerification,
} from './session-capture.js'
import { buildYiveStartupContract } from './yive-startup-contract.js'

interface AgentRunStarterInput {
  agentManager: AgentManager | undefined
  registry: LiveRunRegistry
  onAgentExit: (
    workspaceId: string,
    agentId: string,
    processStateOverride?: 'crashed' | 'stopped'
  ) => void
  persistRunExit?: PersistAgentRunExit
  store: AgentRunStarterStorePort
  sessionStore: AgentSessionStorePort
  tokenRegistry: AgentTokenRegistry
  getAgent: ((workspaceId: string, agentId: string) => AgentIdentity | undefined) | undefined
  restartPolicy: RestartPolicy
}

export const createAgentRunStarter =
  ({
    agentManager,
    registry,
    onAgentExit,
    persistRunExit,
    store,
    sessionStore,
    tokenRegistry,
    getAgent,
    restartPolicy,
  }: AgentRunStarterInput) =>
  async (
    workspace: WorkspaceSummary,
    agentId: string,
    config: AgentLaunchConfigInput,
    hivePort: string,
    options: { suppressStartupInstructions?: boolean } = {}
  ) => {
    if (!agentManager) throw new Error('Agent manager is required to start agents')

    const agent = getAgent?.(workspace.id, agentId)
    const { providerAdapter, sessionCaptureSnapshot, startConfig, startEnv } =
      buildAgentRunBootstrap(
        workspace,
        agentId,
        config,
        sessionStore,
        agent,
        !options.suppressStartupInstructions && agent
          ? buildYiveStartupContract({ agent, workspace })
          : undefined
      )
    const handledRunExits = new Set<string>()
    const abortedRunIds = new Set<string>()
    const startedAt = Date.now()
    const token = tokenRegistry.issue(agentId)
    const exitContext: AgentRunExitContext = {
      agentId,
      handledRunExits,
      onAgentExit,
      ...(persistRunExit ? { persistRunExit } : {}),
      registry,
      sessionStore,
      startConfig,
      store,
      token,
      tokenRegistry,
      workspace,
    }
    const startInput = {
      agentId,
      command: startConfig.command,
      cwd: workspace.path,
      env: {
        ...startEnv,
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'hive',
        HIVE_PORT: hivePort,
        HIVE_AGENT_TOKEN: token,
      },
      onExit: ({ runId, exitCode }: { runId: string; exitCode: number | null }) => {
        const endedAt = Date.now()
        try {
          if (
            !handleAgentRunExit(exitContext, { exitCode, endedAt, runId }) &&
            abortedRunIds.has(runId)
          ) {
            registry.clearPendingExitCode(runId)
          }
        } catch (error) {
          console.error(`[yive] failed to persist Agent exit coordination for ${agentId}`, error)
        }
      },
    }

    let run: Awaited<ReturnType<AgentManager['startAgent']>>
    try {
      run = await agentManager.startAgent(
        startConfig.args ? { ...startInput, args: startConfig.args } : startInput
      )
    } catch (error) {
      tokenRegistry.revokeIfMatches(agentId, token)
      throw error
    }
    const liveRun: LiveAgentRun = {
      ...run,
      exitCode: run.status === 'error' ? run.exitCode : null,
      ...(startConfig.resumedSessionId ? { resumedSessionId: startConfig.resumedSessionId } : {}),
      ...(startConfig.sessionIdCapture
        ? { sessionCapture: { ...startConfig.sessionIdCapture } }
        : {}),
      startedAt,
      status: run.status === 'error' ? 'error' : 'starting',
    }
    try {
      store.insertAgentRun(
        run.runId,
        agentId,
        startedAt,
        run.pid,
        run.status === 'error' ? 'starting' : liveRun.status,
        run.status === 'error' ? null : liveRun.exitCode
      )
    } catch (error) {
      abortedRunIds.add(run.runId)
      registry.clearPendingExitCode(run.runId)
      tokenRegistry.revokeIfMatches(agentId, token)
      agentManager.stopRun(run.runId)
      throw error
    }
    registry.createExitEntry(run.runId)
    registry.add(liveRun)

    if (run.status === 'error') {
      handleAgentRunExit(exitContext, {
        exitCode: run.exitCode,
        endedAt: Date.now(),
        runId: run.runId,
      })
      return liveRun
    }

    const postStartWriter = createPostStartInputWriterAsync(
      agentManager,
      startConfig.interactiveCommand ?? startConfig.command
    )
    const injectRecovery = () => {
      if (liveRun.postStartRecovery) return liveRun.postStartRecovery
      const recovery = restartPolicy.injectPostStartMessage({
        agentId,
        runId: run.runId,
        startConfig,
        workspace,
        writeToRun: postStartWriter,
      })
      liveRun.postStartRecovery = recovery
      void recovery.catch((error) => {
        console.error(`[yive] failed to inject restart Runtime Context for ${agentId}`, error)
      })
      return recovery
    }
    const injectRecoveryForVerifiedSession = (sessionId: string) => {
      if (startConfig.resumedSessionId === sessionId) injectRecovery()
    }

    const verifySession = (sessionId: string) => {
      const currentRun = registry.get(run.runId)
      if (!currentRun || currentRun.stopping || ['error', 'exited'].includes(currentRun.status)) {
        return
      }
      if (currentRun.sessionId === sessionId) {
        injectRecoveryForVerifiedSession(sessionId)
        return
      }
      if (currentRun.sessionId) {
        sessionStore.failPendingSaveIntent(workspace.id, agentId, run.runId, 'session_changed')
        if (!sessionStore.getSessionBinding(workspace.id, agentId)?.savedAt) {
          sessionStore.setLastSessionId(workspace.id, agentId, sessionId, startConfig.provider)
        }
        injectRecoveryForVerifiedSession(sessionId)
        currentRun.sessionId = sessionId
        return
      }
      const intent = sessionStore.getSaveIntent(workspace.id, agentId)
      const completed =
        intent?.state === 'waiting' && intent.runId === run.runId
          ? sessionStore.completeSaveIntent(workspace.id, agentId, run.runId, sessionId)
          : undefined
      if (!completed && !sessionStore.getSessionBinding(workspace.id, agentId)?.savedAt) {
        sessionStore.setLastSessionId(workspace.id, agentId, sessionId, startConfig.provider)
      }
      injectRecoveryForVerifiedSession(sessionId)
      currentRun.sessionId = sessionId
    }
    if (sessionCaptureSnapshot && startConfig.sessionIdCapture) {
      const sessionCapture = startConfig.sessionIdCapture
      if (providerAdapter && !startConfig.resumedSessionId) {
        startAgentRunCapture({
          onSessionCaptured: verifySession,
          sessionCaptureSnapshot,
          startConfig,
          workspace,
        })
      }
      if (
        startConfig.sessionIdCapture.source === 'codex_session_jsonl_dir' ||
        startConfig.sessionIdCapture.source === 'claude_project_jsonl_dir'
      ) {
        void watchSessionVerification({
          capture: startConfig.sessionIdCapture,
          cwd: workspace.path,
          isActive: () => {
            const currentRun = registry.get(run.runId)
            return Boolean(
              currentRun &&
                !currentRun.stopping &&
                (currentRun.status === 'starting' || currentRun.status === 'running')
            )
          },
          onAmbiguous: () => {
            sessionStore.failPendingSaveIntent(
              workspace.id,
              agentId,
              run.runId,
              'ambiguous_session'
            )
          },
          onVerified: verifySession,
          snapshot: sessionCaptureSnapshot,
        })
      } else {
        startAgentRunCapture({
          onSessionCaptured: verifySession,
          sessionCaptureSnapshot,
          startConfig,
          workspace,
        })
      }
      if (
        providerAdapter?.canVerifyResumeAtPromptReady &&
        startConfig.resumedSessionId &&
        sessionCaptureSnapshot.expectedSessionId === startConfig.resumedSessionId
      ) {
        const expectedSessionId = startConfig.resumedSessionId
        const verifyAtPromptReady = async () => {
          while (true) {
            const currentRun = registry.get(run.runId)
            if (
              !currentRun ||
              currentRun.stopping ||
              currentRun.status === 'error' ||
              currentRun.status === 'exited' ||
              currentRun.sessionId
            ) {
              return
            }
            const managerRun = agentManager.getRun(run.runId)
            if (
              hasInteractivePromptReady(
                managerRun.output,
                startConfig.interactiveCommand ?? startConfig.command
              )
            ) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 250)
                timer.unref()
              })
              const result = resolvePromptReadyResumeVerification(
                workspace.path,
                sessionCapture,
                sessionCaptureSnapshot
              )
              if (result.state === 'verified') verifySession(expectedSessionId)
              return
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 50)
              timer.unref()
            })
          }
        }
        void verifyAtPromptReady().catch((error) => {
          console.error(`[yive] failed to verify resumed Provider prompt for ${agentId}`, error)
        })
      }
    }
    if (!startConfig.resumedSessionId) injectRecovery()

    if (registry.hasPendingExitCode(run.runId)) {
      const exitCode = registry.getPendingExitCode(run.runId) ?? null
      queueMicrotask(() => {
        try {
          handleAgentRunExit(exitContext, { exitCode, endedAt: Date.now(), runId: run.runId })
        } catch (error) {
          console.error(`[yive] failed to persist Agent exit coordination for ${agentId}`, error)
        }
      })
    }

    return liveRun
  }
