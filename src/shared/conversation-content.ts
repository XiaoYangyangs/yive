const PROVIDER_HIDDEN_BLOCK = /\s*<((?:hive-)?system-reminder)\b[^>]*>[\s\S]*?<\/\1\s*>\s*/giu
const BASE64_LIKE_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/gu
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu
const QUERY_TOKEN_PATTERN = /([?&](?:agent_token|api_key|pairing_token|token)=)[^&\s"'<>]+/giu
const STANDALONE_TOKEN_PATTERN =
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu
const TOKEN_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|ACCESS_KEY|PRIVATE_KEY)|agent_token|api_key|authorization|client_secret|password|passwd|passphrase|access_key|secret_key|x-hive-agent-token)\b\s*[:=]\s*["']?[^"'\s,;)]+/giu
const UNC_PATH_PATTERN = /\\\\[^\\\s"'`<>]+\\[^\s"'`<>]+/gu
const UNIX_PATH_PATTERN = /(^|[\s("'=])\/(?!\/)[^\s"'`<>]+/gu
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`<>]+/gu

export const normalizeVerifiedConversationText = (text: string) =>
  text
    .replace(PROVIDER_HIDDEN_BLOCK, '')
    .replace(TOKEN_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(QUERY_TOKEN_PATTERN, '$1[redacted]')
    .replace(STANDALONE_TOKEN_PATTERN, '[redacted token]')
    .replace(WINDOWS_PATH_PATTERN, '[local path]')
    .replace(UNC_PATH_PATTERN, '[local path]')
    .replace(UNIX_PATH_PATTERN, '$1[local path]')
    .replace(BASE64_LIKE_PATTERN, '[redacted base64]')
    .trim()
