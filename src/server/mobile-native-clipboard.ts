import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ConflictError } from './http-errors.js'

const execFileAsync = promisify(execFile)

const POWERSHELL_SET_IMAGE_CLIPBOARD = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$path = $env:HIVE_MOBILE_CLIPBOARD_IMAGE_PATH
if ([string]::IsNullOrWhiteSpace($path)) {
  throw 'Missing image path'
}

$resolved = (Resolve-Path -LiteralPath $path).ProviderPath
$data = New-Object System.Windows.Forms.DataObject
$bitmap = New-Object System.Drawing.Bitmap($resolved)

try {
  $data.SetImage($bitmap)

  $files = New-Object System.Collections.Specialized.StringCollection
  [void] $files.Add($resolved)
  $data.SetFileDropList($files)
  $data.SetText($resolved)

  $lastError = $null
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
      $lastError = $null
      break
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 80
    }
  }
  if ($null -ne $lastError) {
    throw $lastError
  }
} finally {
  $bitmap.Dispose()
}
`

export type MobileNativeClipboardPaste = (imagePath: string) => Promise<void>

const pasteImageToNativeClipboard: MobileNativeClipboardPaste = async (imagePath) => {
  if (process.platform !== 'win32') {
    throw new ConflictError('Native image paste is only supported on Windows desktop runtime')
  }

  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        POWERSHELL_SET_IMAGE_CLIPBOARD,
      ],
      {
        env: {
          ...process.env,
          HIVE_MOBILE_CLIPBOARD_IMAGE_PATH: imagePath,
        },
        timeout: 5000,
        windowsHide: true,
      }
    )
  } catch (error) {
    if (error instanceof ConflictError) throw error
    const message = error instanceof Error ? error.message : 'Unknown clipboard error'
    throw new ConflictError(`Failed to place image on native clipboard: ${message}`)
  }
}

let mobileNativeClipboardPaste: MobileNativeClipboardPaste = pasteImageToNativeClipboard

export const pasteMobileImageToNativeClipboard = (imagePath: string) =>
  mobileNativeClipboardPaste(imagePath)

export const setMobileNativeClipboardPasteForTests = (next: MobileNativeClipboardPaste | null) => {
  mobileNativeClipboardPaste = next ?? pasteImageToNativeClipboard
}
