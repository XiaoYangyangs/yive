import { ImagePlus, RefreshCw, X } from 'lucide-react'

import type { MobileChatAttachment } from '../../../src/shared/types.js'
import './MobileChatAttachments.css'

export interface MobileChatDraftAttachment {
  clientId: string
  error?: string
  file: File
  previewUrl: string
  remote?: MobileChatAttachment
  status: 'error' | 'uploaded' | 'uploading'
}

export const MobileChatAttachmentPicker = ({
  disabled,
  items,
  onFiles,
  onRemove,
  onRetry,
}: {
  disabled: boolean
  items: MobileChatDraftAttachment[]
  onFiles: (files: File[]) => void
  onRemove: (clientId: string) => void
  onRetry: (clientId: string) => void
}) => (
  <div className="mobile-chat-attachments__picker">
    {items.length > 0 ? (
      <div className="mobile-chat-attachments__drafts">
        {items.map((item) => (
          <figure data-status={item.status} key={item.clientId}>
            <img alt={item.file.name} src={item.previewUrl} />
            <figcaption>
              <span>{item.file.name}</span>
              <small>
                {item.status === 'uploading'
                  ? '上传中…'
                  : item.status === 'uploaded'
                    ? '已上传'
                    : (item.error ?? '上传失败')}
              </small>
            </figcaption>
            {item.status === 'error' ? (
              <button
                aria-label={`重试上传 ${item.file.name}`}
                onClick={() => onRetry(item.clientId)}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={15} />
              </button>
            ) : null}
            <button
              aria-label={`移除 ${item.file.name}`}
              onClick={() => onRemove(item.clientId)}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </figure>
        ))}
      </div>
    ) : null}
    <label className="mobile-chat-attachments__add">
      <ImagePlus aria-hidden="true" size={18} />
      <span>添加图片</span>
      <input
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled}
        multiple
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ''
        }}
        type="file"
      />
    </label>
  </div>
)

export const MobileChatAttachmentCards = ({
  attachments,
  onDownload,
}: {
  attachments: MobileChatAttachment[]
  onDownload: (attachment: MobileChatAttachment) => void
}) =>
  attachments.length > 0 ? (
    <div className="mobile-chat-attachments__cards">
      {attachments.map((attachment) => (
        <button key={attachment.file_id} onClick={() => onDownload(attachment)} type="button">
          <ImagePlus aria-hidden="true" size={18} />
          <span>
            <strong>{attachment.name}</strong>
            <small>{Math.max(1, Math.ceil(attachment.size / 1024))} KB · 点击下载</small>
          </span>
        </button>
      ))}
    </div>
  ) : null
