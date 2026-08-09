import { type AgentManager, AgentRunNotFoundError } from './agent-manager.js'
import { getProviderAdapterForCommand } from './provider-adapter.js'

const READY_CHECK_INTERVAL_MS = 50
const READY_TIMEOUT_MS = 3000
const MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 600
const MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 1500
const PASTE_CHARS_PER_DELAY_MS = 4
const PASTE_ACK_CHECK_INTERVAL_MS = 50
const PASTE_ACK_SETTLE_DELAY_MS = 100
const PASTE_ACK_TIMEOUT_MS = 3000

export const toBracketedPasteSubmission = (text: string) => `\u001b[200~${text}\u001b[201~`

const getSubmitAfterPasteDelayMs = (text: string) =>
  Math.min(
    MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
    Math.max(MIN_SUBMIT_AFTER_PASTE_DELAY_MS, Math.ceil(text.length / PASTE_CHARS_PER_DELAY_MS))
  )

export const isInteractiveAgentCommand = (command: string) =>
  Boolean(getProviderAdapterForCommand(command))

export const hasInteractivePromptReady = (output: string, command = '') => {
  return (
    (getProviderAdapterForCommand(command)?.isPromptReady(output) ?? false) ||
    /(?:^|[\r\n])\s*[❯›]\s*/u.test(output) ||
    false
  )
}

export const hasBracketedPasteAcknowledgement = (output: string, baselineLength: number) =>
  /\[(?:Pasted text #\d+|Pasted Content \d+ chars)\b/u.test(output.slice(baselineLength))

const usesBracketedPaste = (command: string) => Boolean(getProviderAdapterForCommand(command))
const canTimeoutBeforePromptReady = (command: string) =>
  getProviderAdapterForCommand(command)?.canTimeoutBeforePromptReady ?? true
const isWritableRunStatus = (status: string | undefined) =>
  status === undefined || status === 'starting' || status === 'running'

const getRunIfPresent = (agentManager: AgentManager, runId: string) => {
  try {
    return agentManager.getRun(runId)
  } catch (error) {
    if (error instanceof AgentRunNotFoundError) return null
    throw error
  }
}

const writeIfRunWritable = (agentManager: AgentManager, runId: string, text: string) => {
  const run = getRunIfPresent(agentManager, runId)
  if (!run || !isWritableRunStatus(run.status)) return false
  agentManager.writeInput(runId, text)
  return true
}

export const createPostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => void) => {
  const writeAsync = createPostStartInputWriterAsync(agentManager, command)
  return (runId, text) => {
    void writeAsync(runId, text).catch((error) => {
      console.error(`[yive] delayed PTY input failed for run ${runId}`, error)
    })
  }
}

const submitPastedInteractiveInputAsync = (
  agentManager: AgentManager,
  runId: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean,
  isAcknowledged = hasBracketedPasteAcknowledgement,
  onSubmitted?: () => void,
  onWriteFailed?: () => void
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const pastedAt = Date.now()
    const minDelay = getSubmitAfterPasteDelayMs(text)
    let acknowledgedAt: number | null = null

    const getWritableOutput = () => {
      const run = getRunIfPresent(agentManager, runId)
      return run && isWritableRunStatus(run.status) ? run.output : null
    }

    const failWrite = (error?: unknown) => {
      try {
        onWriteFailed?.()
      } catch (rollbackError) {
        reject(rollbackError)
        return
      }
      if (error !== undefined) reject(error)
      else resolve(false)
    }

    const submit = () => {
      let submitted: boolean
      try {
        submitted = writeIfRunWritable(agentManager, runId, '\r')
      } catch (error) {
        failWrite(error)
        return
      }
      if (!submitted) {
        failWrite()
        return
      }
      try {
        onSubmitted?.()
      } catch (error) {
        reject(error)
        return
      }
      resolve(true)
    }

    const trySubmit = () => {
      if (!waitForPasteAck) {
        submit()
        return
      }

      let output: string | null
      try {
        output = getWritableOutput()
      } catch (error) {
        failWrite(error)
        return
      }
      if (output === null) {
        failWrite()
        return
      }
      if (acknowledgedAt === null && isAcknowledged(output, baselineLength)) {
        acknowledgedAt = Date.now()
      }

      const elapsed = Date.now() - pastedAt
      const ackSettled =
        acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
      if ((ackSettled && elapsed >= minDelay) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
        submit()
        return
      }
      setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
    }

    setTimeout(trySubmit, minDelay)
  })

export const createPostStartInputWriterAsync = (
  agentManager: AgentManager,
  command: string,
  options: {
    beforePaste?: string
    beforeWrite?: () => void
    onSubmitted?: () => void
    onWriteFailed?: () => void
    prepareText?: () => string | null
  } = {}
): ((runId: string, text: string) => Promise<boolean>) => {
  if (!isInteractiveAgentCommand(command)) {
    return async (runId, text) => {
      const preparedText = options.prepareText ? options.prepareText() : text
      if (preparedText === null) return false
      options.beforeWrite?.()
      let submitted: boolean
      try {
        submitted = writeIfRunWritable(agentManager, runId, `${preparedText}\n`)
      } catch (error) {
        options.onWriteFailed?.()
        throw error
      }
      if (!submitted) options.onWriteFailed?.()
      if (submitted) options.onSubmitted?.()
      return submitted
    }
  }

  return (runId, text) =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const failAfterCommit = (error?: unknown) => {
        try {
          options.onWriteFailed?.()
        } catch (rollbackError) {
          reject(rollbackError)
          return
        }
        if (error !== undefined) reject(error)
        else resolve(false)
      }
      const tryWrite = () => {
        let run: ReturnType<typeof getRunIfPresent>
        try {
          run = getRunIfPresent(agentManager, runId)
        } catch (error) {
          reject(error)
          return
        }
        const output = run && isWritableRunStatus(run.status) ? run.output : null
        if (output === null) {
          resolve(false)
          return
        }
        if (
          hasInteractivePromptReady(output, command) ||
          (canTimeoutBeforePromptReady(command) && Date.now() - startedAt >= READY_TIMEOUT_MS)
        ) {
          let preparedText: string | null
          try {
            preparedText = options.prepareText ? options.prepareText() : text
          } catch (error) {
            reject(error)
            return
          }
          if (preparedText === null) {
            resolve(false)
            return
          }
          try {
            options.beforeWrite?.()
          } catch (error) {
            reject(error)
            return
          }
          const baselineLength = output.length
          const providerAdapter = getProviderAdapterForCommand(command)
          const terminalInput = providerAdapter
            ? providerAdapter.toPromptInput(preparedText)
            : usesBracketedPaste(command)
              ? toBracketedPasteSubmission(preparedText)
              : preparedText
          try {
            if (
              options.beforePaste &&
              !writeIfRunWritable(agentManager, runId, options.beforePaste)
            ) {
              failAfterCommit()
              return
            }
            if (!writeIfRunWritable(agentManager, runId, terminalInput)) {
              failAfterCommit()
              return
            }
          } catch (error) {
            failAfterCommit(error)
            return
          }
          void submitPastedInteractiveInputAsync(
            agentManager,
            runId,
            preparedText,
            baselineLength,
            usesBracketedPaste(command),
            providerAdapter?.hasPasteAcknowledgement,
            options.onSubmitted,
            options.onWriteFailed
          ).then(resolve, reject)
          return
        }
        setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
      }
      tryWrite()
    })
}
