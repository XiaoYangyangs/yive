import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

export type MobileAgentAuxKey = {
  chunk: string
  label: string
}

type MobileAgentComposerProps = {
  auxKeys: MobileAgentAuxKey[]
  disabled: boolean
  disabledMessage?: string | null
  imageUploading: boolean
  onSendAuxKey: (chunk: string) => void
  onUploadImage: (file: File) => void
}

export const MobileAgentComposer = ({
  auxKeys,
  disabled,
  disabledMessage,
  imageUploading,
  onSendAuxKey,
  onUploadImage,
}: MobileAgentComposerProps) => {
  const [toolsOpen, setToolsOpen] = useState(false)

  useEffect(() => {
    if (!toolsOpen || typeof window === 'undefined' || !window.visualViewport) return
    const viewport = window.visualViewport
    const initialHeight = viewport.height
    const handleViewportResize = () => {
      if (viewport.height < initialHeight - 80) setToolsOpen(false)
    }
    viewport.addEventListener('resize', handleViewportResize)
    return () => viewport.removeEventListener('resize', handleViewportResize)
  }, [toolsOpen])

  useEffect(() => {
    if (disabled) setToolsOpen(false)
  }, [disabled])

  return (
    <div className="mobile-agent-composer">
      <div className="mobile-agent-composer__tools-row">
        <button
          aria-expanded={toolsOpen}
          aria-label={toolsOpen ? '收起终端工具' : '打开终端工具'}
          className="mobile-terminal__tools-toggle"
          disabled={disabled}
          onClick={() => setToolsOpen((current) => !current)}
          type="button"
        >
          <Plus aria-hidden size={20} strokeWidth={2.4} />
        </button>
        {disabled && disabledMessage ? (
          <span className="mobile-agent-composer__disabled-message" role="status">
            {disabledMessage}
          </span>
        ) : null}
      </div>
      {toolsOpen ? (
        <fieldset className="mobile-terminal__tool-panel">
          <legend>终端工具</legend>
          <label
            className="mobile-terminal__image-upload"
            data-disabled={disabled || imageUploading || undefined}
          >
            <span>{imageUploading ? '上传中...' : '上传图片'}</span>
            <input
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              disabled={disabled || imageUploading}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) onUploadImage(file)
              }}
              type="file"
            />
          </label>
          <div className="mobile-terminal__keys">
            {auxKeys.map((key) => (
              <button
                disabled={disabled}
                key={key.label}
                onClick={() => onSendAuxKey(key.chunk)}
                type="button"
              >
                {key.label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  )
}
