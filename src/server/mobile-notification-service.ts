import { sendFcmNotification } from './fcm-notifier.js'
import { sendFeishuNotification } from './feishu-notifier.js'
import { createMobileFileExchangeItemFromWorkspacePath } from './routes-file-exchange.js'
import type { RuntimeStore } from './runtime-store.js'
import { sendWechatNotification } from './wechat-notifier.js'
import { sendXiaomiNotification } from './xiaomi-notifier.js'

export const sendMobileNotification = async ({
  body,
  imagePath,
  store,
  title,
  workspaceId,
}: {
  body: string
  imagePath?: string
  store: RuntimeStore
  title: string
  workspaceId: string
}) => {
  const imageItem = imagePath
    ? createMobileFileExchangeItemFromWorkspacePath({
        imageOnly: true,
        store,
        workspaceId,
        workspacePath: imagePath,
      })
    : null
  const notification = store.pushMobileNotification({
    body,
    ...(imageItem
      ? {
          image: {
            file_id: imageItem.id,
            mime_type: imageItem.mimeType,
            name: imageItem.name,
            size: imageItem.size,
          },
        }
      : {}),
    title,
    workspaceId,
  })
  const wechat = await sendWechatNotification({
    body: notification.body,
    title: notification.title,
  })
  const feishu = await sendFeishuNotification({
    body: notification.body,
    ...(imageItem
      ? {
          image: {
            localPath: imageItem.localPath,
            mimeType: imageItem.mimeType,
            name: imageItem.name,
          },
        }
      : {}),
    title: notification.title,
  })
  const fcm = await sendFcmNotification({
    body: notification.body,
    data: { notification_id: notification.id, workspace_id: notification.workspace_id },
    title: notification.title,
    tokens: store
      .listMobilePushTokens([notification.workspace_id])
      .filter((registration) => registration.platform === 'fcm')
      .map((registration) => registration.token),
  })
  const xiaomi = await sendXiaomiNotification({
    body: notification.body,
    data: { notification_id: notification.id, workspace_id: notification.workspace_id },
    title: notification.title,
    tokens: store
      .listMobilePushTokens([notification.workspace_id])
      .filter((registration) => registration.platform === 'xiaomi')
      .map((registration) => registration.token),
  })
  return {
    feishu,
    fcm,
    imageArtifact: imageItem?.workspacePath,
    notification,
    wechat,
    workspace_id: workspaceId,
    xiaomi,
  }
}
