export { normalizeVerifiedConversationText } from '../shared/conversation-content.js'

export const isYiveStartupInstruction = (text: string) =>
  text.includes('Hive session binding: workspace_id=') &&
  text.includes('Mobile file direction: .hive/mobile-attachments.json') &&
  text.includes('To send a generated workspace file to the phone')
