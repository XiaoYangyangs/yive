import { execFileSync } from 'node:child_process'

import type { IPty } from 'node-pty'

import type { AgentRunRecord, AgentRunSnapshot } from './agent-manager.js'
import type { PtyOutputBus } from './pty-output-bus.js'

export const MAX_RUN_OUTPUT_LENGTH = 1_000_000
const FORCE_KILL_DELAY_MS = 750

export const toAgentRunSnapshot = (run: AgentRunRecord): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: run.agentId,
  pid: run.process.pid,
  status:
    (run.stopping || run.process.isStopped()) && run.status !== 'exited' && run.status !== 'error'
      ? 'exited'
      : run.status,
  output: run.output,
  exitCode: run.exitCode,
  lastInputAt: run.lastInputAt ?? null,
  lastOutputAt: run.lastOutputAt ?? null,
})

export const finishAgentRun = (
  run: AgentRunRecord,
  exitCode: number | null,
  ptyOutputBus: PtyOutputBus
) => {
  if (run.status === 'exited' || run.status === 'error') return
  run.status = run.stopping ? 'exited' : exitCode === 0 ? 'exited' : 'error'
  run.exitCode = exitCode
  run.onExit?.({ runId: run.runId, exitCode })
  ptyOutputBus.clear(run.runId)
}

export const attachAgentPty = (run: AgentRunRecord, pty: IPty, ptyOutputBus: PtyOutputBus) => {
  let stdinClosed = false
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  const resolveProcessGroupId = () => {
    if (process.platform === 'win32' || pty.pid <= 0) return null
    try {
      const value = execFileSync('ps', ['-o', 'pgid=', '-p', String(pty.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const groupId = Number(value)
      if (Number.isInteger(groupId) && groupId > 0) return groupId
    } catch {
      return pty.pid
    }
    return pty.pid
  }
  const processGroupId = resolveProcessGroupId()
  const stopped = () => run.status === 'exited' || run.status === 'error'
  const isInactiveResizeError = (error: unknown) => {
    if (!(error instanceof Error)) return false
    return /already exited|not active|closed/i.test(error.message)
  }
  const ignoreMissingProcess = (error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ESRCH') throw error
  }
  const ignoreBestEffortGroupKillError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
  const killProcessGroup = (signal: NodeJS.Signals) => {
    if (process.platform === 'win32' || processGroupId === null) return
    try {
      process.kill(-processGroupId, signal)
    } catch (error) {
      ignoreBestEffortGroupKillError(error)
    }
  }
  const killWindowsPty = () => {
    try {
      execFileSync('taskkill', ['/pid', String(pty.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      // The process may already have exited by the time Windows taskkill runs.
    }
  }
  const killPty = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') {
        killWindowsPty()
      } else pty.kill(signal)
    } catch (error) {
      ignoreMissingProcess(error)
    }
    killProcessGroup(signal)
  }
  const clearForceKillTimer = () => {
    if (!forceKillTimer) return
    clearTimeout(forceKillTimer)
    forceKillTimer = undefined
  }
  const cleanupProcessGroup = () => {
    clearForceKillTimer()
    killProcessGroup('SIGKILL')
  }
  const scheduleForceKill = () => {
    if (forceKillTimer) return
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined
      try {
        if (process.platform === 'win32') killWindowsPty()
        else pty.kill('SIGKILL')
      } catch (error) {
        ignoreMissingProcess(error)
      }
      killProcessGroup('SIGKILL')
    }, FORCE_KILL_DELAY_MS)
    forceKillTimer.unref?.()
  }
  run.process = {
    isStopped() {
      return run.stopping === true || stopped()
    },
    pause() {
      pty.pause()
    },
    pid: pty.pid,
    resize(cols, rows) {
      if (stopped()) return
      try {
        pty.resize(cols, rows)
      } catch (error) {
        if (stopped() || isInactiveResizeError(error)) return
        throw error
      }
    },
    resume() {
      pty.resume()
    },
    stop() {
      if (run.stopping || stopped()) {
        cleanupProcessGroup()
        return
      }
      run.stopping = true
      killPty('SIGTERM')
      stdinClosed = true
      scheduleForceKill()
      finishAgentRun(run, null, ptyOutputBus)
    },
    write(text) {
      if (stdinClosed || run.status === 'exited' || run.status === 'error') {
        throw new Error(`PTY is not active for run: ${run.runId}`)
      }
      pty.write(text)
    },
  }

  pty.onData((chunk) => {
    if (run.status === 'starting') run.status = 'running'
    run.lastOutputAt = Date.now()
    run.output += chunk
    if (run.output.length > MAX_RUN_OUTPUT_LENGTH)
      run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH)
    ptyOutputBus.publish(run.runId, chunk)
  })

  pty.onExit((event) => {
    stdinClosed = true
    cleanupProcessGroup()
    finishAgentRun(run, event.exitCode, ptyOutputBus)
  })
}
