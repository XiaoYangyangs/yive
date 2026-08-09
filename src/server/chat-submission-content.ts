import type { MobileChatAttachment } from '../shared/types.js'

export const buildChatSubmissionDeliveryText = (
  body: string,
  attachments: MobileChatAttachment[]
) => {
  if (attachments.length === 0) return body
  return [
    body,
    '[Yive mobile attachments]',
    JSON.stringify({
      artifacts: attachments.map((attachment) => ({
        mime_type: attachment.mime_type,
        name: attachment.name,
        path: attachment.artifact,
        size: attachment.size,
      })),
    }),
    'Read these Workspace-relative Artifacts directly as image context.',
  ]
    .filter(Boolean)
    .join('\n')
}
