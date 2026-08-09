import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isWorkspaceShellRun, type TerminalInputProfile, type TerminalRunSummary } from '../api.js'

const OPTIMISTIC_RUN_TTL_MS = 3000

type TimerId = number

interface OptimisticRunInput {
  agentId: string
  agentName: string
  runId: string
  status?: string
  terminalInputProfile?: TerminalInputProfile
  workspaceId: string
}

export const mergeTerminalRuns = (
  actualRuns: TerminalRunSummary[],
  optimisticRuns: TerminalRunSummary[],
  workspaceId?: string | null
): TerminalRunSummary[] => {
  const actualRunIds = new Set(actualRuns.map((run) => run.run_id))
  const actualAgentIds = new Set(actualRuns.map((run) => run.agent_id))
  return [
    ...actualRuns,
    ...optimisticRuns.filter((run) => {
      if (actualRunIds.has(run.run_id)) return false
      if (workspaceId && isWorkspaceShellRun(run, workspaceId)) return true
      return !actualAgentIds.has(run.agent_id)
    }),
  ]
}

export const useOptimisticTerminalRuns = (
  workspaceId: string | null,
  actualRuns: TerminalRunSummary[]
) => {
  const [optimisticRunsByWorkspaceId, setOptimisticRunsByWorkspaceId] = useState<
    Record<string, TerminalRunSummary[]>
  >({})
  const [suppressedAgentsByWorkspaceId, setSuppressedAgentsByWorkspaceId] = useState<
    Record<string, string[]>
  >({})
  const timersRef = useRef(new Map<string, TimerId>())

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer)
      timersRef.current.clear()
    },
    []
  )

  const forgetOptimisticAgent = useCallback((targetWorkspaceId: string, agentId: string) => {
    setOptimisticRunsByWorkspaceId((current) => ({
      ...current,
      [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter(
        (run) => run.agent_id !== agentId
      ),
    }))
    setSuppressedAgentsByWorkspaceId((current) => {
      const existing = current[targetWorkspaceId] ?? []
      if (existing.includes(agentId)) return current
      return { ...current, [targetWorkspaceId]: [...existing, agentId] }
    })
  }, [])

  const forgetOptimisticRun = useCallback((targetWorkspaceId: string, runId: string) => {
    const existingTimer = timersRef.current.get(runId)
    if (existingTimer) window.clearTimeout(existingTimer)
    timersRef.current.delete(runId)
    setOptimisticRunsByWorkspaceId((current) => ({
      ...current,
      [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter((run) => run.run_id !== runId),
    }))
  }, [])

  useEffect(() => {
    if (!workspaceId || actualRuns.length === 0) return
    const actualRunIds = new Set(actualRuns.map((run) => run.run_id))
    setOptimisticRunsByWorkspaceId((current) => {
      const currentRuns = current[workspaceId] ?? []
      const retained = currentRuns.filter((run) => {
        if (!actualRunIds.has(run.run_id)) return true
        const timer = timersRef.current.get(run.run_id)
        if (timer) window.clearTimeout(timer)
        timersRef.current.delete(run.run_id)
        return false
      })
      if (retained.length === currentRuns.length) return current
      return { ...current, [workspaceId]: retained }
    })
  }, [actualRuns, workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    const suppressed = suppressedAgentsByWorkspaceId[workspaceId] ?? []
    if (suppressed.length === 0) return
    const actualAgentIds = new Set(actualRuns.map((run) => run.agent_id))
    const retained = suppressed.filter((agentId) => actualAgentIds.has(agentId))
    if (retained.length === suppressed.length) return
    setSuppressedAgentsByWorkspaceId((current) => ({ ...current, [workspaceId]: retained }))
  }, [actualRuns, suppressedAgentsByWorkspaceId, workspaceId])

  const recordOptimisticRun = useCallback(
    ({
      agentId,
      agentName,
      runId,
      status = 'starting',
      terminalInputProfile = 'default',
      workspaceId: targetWorkspaceId,
    }: OptimisticRunInput) => {
      const run: TerminalRunSummary = {
        agent_id: agentId,
        agent_name: agentName,
        run_id: runId,
        status,
        terminal_input_profile: terminalInputProfile,
      }
      setOptimisticRunsByWorkspaceId((current) => {
        const recordsWorkspaceShell = isWorkspaceShellRun(run, targetWorkspaceId)
        const retained = (current[targetWorkspaceId] ?? []).filter((item) => {
          if (item.run_id === run.run_id) return false
          if (recordsWorkspaceShell) return true
          return item.agent_id !== run.agent_id
        })
        return { ...current, [targetWorkspaceId]: [...retained, run] }
      })
      setSuppressedAgentsByWorkspaceId((current) => {
        const next = (current[targetWorkspaceId] ?? []).filter(
          (agentId) => agentId !== run.agent_id
        )
        return next.length === (current[targetWorkspaceId] ?? []).length
          ? current
          : { ...current, [targetWorkspaceId]: next }
      })

      const existingTimer = timersRef.current.get(runId)
      if (existingTimer) window.clearTimeout(existingTimer)
      const timer = window.setTimeout(() => {
        setOptimisticRunsByWorkspaceId((current) => ({
          ...current,
          [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter(
            (item) => item.run_id !== runId
          ),
        }))
        timersRef.current.delete(runId)
      }, OPTIMISTIC_RUN_TTL_MS)
      timersRef.current.set(runId, timer)
    },
    []
  )

  const terminalRuns = useMemo(() => {
    const suppressed = new Set(
      workspaceId ? (suppressedAgentsByWorkspaceId[workspaceId] ?? []) : []
    )
    const visibleActualRuns =
      suppressed.size === 0 ? actualRuns : actualRuns.filter((run) => !suppressed.has(run.agent_id))
    return mergeTerminalRuns(
      visibleActualRuns,
      workspaceId ? (optimisticRunsByWorkspaceId[workspaceId] ?? []) : [],
      workspaceId
    )
  }, [actualRuns, optimisticRunsByWorkspaceId, suppressedAgentsByWorkspaceId, workspaceId])

  return {
    forgetOptimisticAgent,
    forgetOptimisticRun,
    optimisticRunsByWorkspaceId,
    recordOptimisticRun,
    terminalRuns,
  }
}
