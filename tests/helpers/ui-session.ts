export const getUiCookie = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/api/ui/session`)
  const cookie = response.headers.get('set-cookie')
  if (!cookie) {
    throw new Error('Expected UI session cookie')
  }
  return cookie
}

export const getMobileCookie = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/api/ui/session`)
  const cookie = response.headers.get('set-cookie')
  const mobileCookie = cookie
    ?.split(/,\s*(?=hive_[^=]+=)/u)
    .find((part) => part.startsWith('hive_mobile_token='))
  if (!mobileCookie) {
    throw new Error('Expected mobile session cookie')
  }
  return mobileCookie
}
