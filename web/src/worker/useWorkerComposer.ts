import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentProvider, TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { generateWorkerName } from './randomWorkerName.js'
import type { WorkerActions } from './useWorkerActions.js'

interface UseWorkerComposerInput {
  createWorker: WorkerActions['createWorker']
  open: boolean
  workers: TeamListItem[]
}

export interface WorkerComposerState {
  createWorkerError: string | null
  creating: boolean
  provider: AgentProvider | undefined
  workerName: string
  setProvider: (value: AgentProvider | undefined) => void
  setWorkerName: (value: string) => void
  randomizeWorkerName: () => void
  resetError: () => void
  submit: (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => void
}

export const useWorkerComposer = ({
  createWorker,
  workers,
}: UseWorkerComposerInput): WorkerComposerState => {
  const { language } = useI18n()
  const [workerName, setWorkerName] = useState('')
  const [provider, setProvider] = useState<AgentProvider | undefined>()
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const workerNameGeneratedRef = useRef(false)
  const usedNames = useMemo(() => new Set(workers.map((worker) => worker.name)), [workers])

  const setWorkerNameFromUser = (value: string) => {
    workerNameGeneratedRef.current = false
    setWorkerName(value)
  }

  const randomizeWorkerName = () => {
    workerNameGeneratedRef.current = true
    setWorkerName(generateWorkerName({ language, usedNames }))
  }

  useEffect(() => {
    if (workerNameGeneratedRef.current) {
      setWorkerName(generateWorkerName({ language, usedNames }))
    }
  }, [language, usedNames])

  const submit = (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => {
    event.preventDefault()
    setCreating(true)
    setCreateWorkerError(null)
    void createWorker({ name: workerName, provider })
      .then(({ error }) => {
        setWorkerName('')
        workerNameGeneratedRef.current = false
        setProvider(undefined)
        onSuccess()
        if (error) setCreateWorkerError(error)
      })
      .catch((error) => {
        setCreateWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setCreating(false))
  }

  return {
    createWorkerError,
    creating,
    provider,
    workerName,
    setProvider,
    setWorkerName: setWorkerNameFromUser,
    randomizeWorkerName,
    resetError: () => setCreateWorkerError(null),
    submit,
  }
}
