import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { StatusSnapshotRecord } from './status-snapshot-store.js'

export const serializeDispatchRecord = (
  record: DispatchRecord,
  latestStatus?: StatusSnapshotRecord | null
) => ({
  artifacts: record.artifacts,
  created_at: record.createdAt,
  delivered_at: record.deliveredAt,
  from_agent_id: record.fromAgentId,
  id: record.id,
  ...(record.operationKind && record.operationState
    ? {
        lifecycle: {
          attempts: record.operationAttempts,
          error: record.operationError,
          kind: record.operationKind,
          request_id: record.operationRequestId,
          state: record.operationState,
          updated_at: record.operationUpdatedAt,
        },
      }
    : {}),
  queue_position: record.queuePosition,
  ...(latestStatus?.dispatchId === record.id
    ? {
        latest_status: {
          artifacts: latestStatus.artifacts,
          notify: latestStatus.notify,
          request_id: latestStatus.requestId,
          text: latestStatus.text,
          updated_at: latestStatus.createdAt,
        },
      }
    : {}),
  reported_at: record.reportedAt,
  report_outcome: record.reportOutcome,
  report_text: record.reportText,
  replaced_by: record.replacedBy,
  replaces_dispatch_id: record.replacesDispatchId,
  state: record.status,
  submitted_at: record.submittedAt,
  text: record.text,
  to_agent_id: record.toAgentId,
  workspace_id: record.workspaceId,
})
