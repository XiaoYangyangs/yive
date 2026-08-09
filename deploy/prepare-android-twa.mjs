#!/usr/bin/env node

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { writeAndroidAssetLinks } from './write-android-assetlinks.mjs'

const usage = `Usage: node deploy/prepare-android-twa.mjs --domain <https-origin> --static-dir <web-dist> --out-dir <android-twa-dir> --android-package <id> --android-sha256 <fingerprint>

Example:
  node deploy/prepare-android-twa.mjs --domain https://relay.example.com --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 AA:BB:...
`

const readFlag = (argv, name) => {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

const requireFlag = (argv, name) => {
  const value = readFlag(argv, name)?.trim()
  if (!value || value.startsWith('--')) throw new Error(usage)
  return value
}

const normalizeHttpsOrigin = (value) => {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`
  const url = new URL(withScheme)
  if (url.protocol !== 'https:') {
    throw new Error('Android TWA packaging requires an HTTPS origin')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.origin
}

const writeGeneratedFile = async (path, content) => {
  const tempPath = `${path}.tmp`
  await writeFile(tempPath, content, 'utf8')
  await rename(tempPath, path)
}

export const createAndroidTwaPackage = ({
  androidPackage,
  domain,
  sha256Fingerprint,
  staticDir,
}) => {
  const origin = normalizeHttpsOrigin(domain)
  const manifestUrl = `${origin}/manifest.webmanifest`
  const mobileUrl = `${origin}/mobile?relay=1`
  const assetLinksUrl = `${origin}/.well-known/assetlinks.json`
  const domainHost = new URL(origin).host
  const bubblewrapInit = `bubblewrap init --manifest=${manifestUrl}`
  const bubblewrapValidate = `bubblewrap validate --url=${mobileUrl}`
  const domainCheck = `pnpm smoke:relay-domain -- --domain ${domainHost} --android-package ${androidPackage} --android-sha256 ${sha256Fingerprint}`

  const readme = [
    '# Yive Android TWA',
    '',
    'This directory is generated for packaging the mobile Yive PWA as an Android Trusted Web Activity.',
    '',
    '## Required public files',
    '',
    `- Web manifest: ${manifestUrl}`,
    `- Digital Asset Links: ${assetLinksUrl}`,
    `- Mobile start URL: ${mobileUrl}`,
    '',
    '## Commands',
    '',
    '```bash',
    'npm i -g @bubblewrap/cli',
    bubblewrapValidate,
    bubblewrapInit,
    'bubblewrap build',
    './install-twa.sh',
    './verify-device.sh',
    domainCheck,
    '```',
    '',
    'You can run `./check-release.sh` or `./check-release.ps1` from this directory before building a release package. Set `YIVE_REPO_DIR` if this directory is not directly under the Yive repository root.',
    'After `bubblewrap build`, connect an Android device with USB debugging enabled and run `./install-twa.sh` or `./install-twa.ps1` to install and launch the test build.',
    'Then run `./verify-device.sh` or `./verify-device.ps1` to confirm the installed package is visible to adb and launches the Yive mobile start URL.',
    '',
    'Run `pnpm build` first, then publish the static directory after `assetlinks.json` has been generated.',
    'Do not commit release keystores or signing passwords into this directory.',
    '',
  ].join('\n')

  const shellScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'npm i -g @bubblewrap/cli',
    bubblewrapValidate,
    bubblewrapInit,
    'bubblewrap build',
    './install-twa.sh',
    './verify-device.sh',
    '',
  ].join('\n')

  const powershellScript = [
    '$ErrorActionPreference = "Stop"',
    'npm i -g @bubblewrap/cli',
    bubblewrapValidate,
    bubblewrapInit,
    'bubblewrap build',
    '.\\install-twa.ps1',
    '.\\verify-device.ps1',
    '',
  ].join('\r\n')

  const installScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'APK="$' + '{1:-app-release-signed.apk}"',
    'if [[ ! -f "$APK" && -f "app/build/outputs/apk/release/app-release.apk" ]]; then',
    '  APK="app/build/outputs/apk/release/app-release.apk"',
    'fi',
    'if [[ ! -f "$APK" ]]; then',
    '  echo "APK not found. Run bubblewrap build first, or pass the APK path: ./install-twa.sh <apk>" >&2',
    '  exit 1',
    'fi',
    'adb install -r "$APK"',
    `adb shell monkey -p ${androidPackage} 1`,
    '',
  ].join('\n')

  const installPowerShellScript = [
    'param([string]$Apk = "app-release-signed.apk")',
    '$ErrorActionPreference = "Stop"',
    'if (-not (Test-Path -LiteralPath $Apk) -and (Test-Path -LiteralPath "app/build/outputs/apk/release/app-release.apk")) {',
    '  $Apk = "app/build/outputs/apk/release/app-release.apk"',
    '}',
    'if (-not (Test-Path -LiteralPath $Apk)) {',
    '  throw "APK not found. Run bubblewrap build first, or pass the APK path: .\\install-twa.ps1 <apk>"',
    '}',
    'adb install -r $Apk',
    `adb shell monkey -p ${androidPackage} 1`,
    '',
  ].join('\r\n')

  const verifyDeviceScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if ! command -v adb >/dev/null 2>&1; then',
    '  echo "adb not found. Install Android platform-tools and enable USB debugging." >&2',
    '  exit 1',
    'fi',
    'DEVICE_COUNT="$(adb devices | awk \'NR > 1 && $2 == "device" { count++ } END { print count + 0 }\')"',
    'if [[ "$DEVICE_COUNT" -lt 1 ]]; then',
    '  echo "No Android device is connected. Enable USB debugging, approve the computer, then retry." >&2',
    '  adb devices >&2',
    '  exit 1',
    'fi',
    `if ! adb shell pm list packages ${androidPackage} | grep -q "package:${androidPackage}"; then`,
    `  echo "Package ${androidPackage} is not installed. Run ./install-twa.sh first." >&2`,
    '  exit 1',
    'fi',
    `adb shell monkey -p ${androidPackage} 1 >/dev/null`,
    'sleep 1',
    `adb shell am start -a android.intent.action.VIEW -d "${mobileUrl}" ${androidPackage} >/dev/null || true`,
    `echo "Android device check passed for ${androidPackage}"`,
    `echo "Expected mobile start URL: ${mobileUrl}"`,
    '',
  ].join('\n')

  const verifyDevicePowerShellScript = [
    '$ErrorActionPreference = "Stop"',
    'if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {',
    '  throw "adb not found. Install Android platform-tools and enable USB debugging."',
    '}',
    '$devices = adb devices | Select-String -Pattern "\\tdevice$"',
    'if (-not $devices) {',
    '  adb devices',
    '  throw "No Android device is connected. Enable USB debugging, approve the computer, then retry."',
    '}',
    `$packages = adb shell pm list packages ${androidPackage}`,
    `if (-not ($packages -match "package:${androidPackage}")) {`,
    `  throw "Package ${androidPackage} is not installed. Run .\\install-twa.ps1 first."`,
    '}',
    `adb shell monkey -p ${androidPackage} 1 | Out-Null`,
    'Start-Sleep -Seconds 1',
    `adb shell am start -a android.intent.action.VIEW -d "${mobileUrl}" ${androidPackage} | Out-Null`,
    `Write-Host "Android device check passed for ${androidPackage}"`,
    `Write-Host "Expected mobile start URL: ${mobileUrl}"`,
    '',
  ].join('\r\n')

  const releaseCheckScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "$' + '{BASH_SOURCE[0]}")" && pwd)"',
    'REPO_DIR="$' + '{YIVE_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"',
    `pnpm -C "$REPO_DIR" smoke:relay-domain -- --domain ${domainHost} --android-package ${androidPackage} --android-sha256 ${sha256Fingerprint}`,
    '',
  ].join('\n')

  const releaseCheckPowerShellScript = [
    '$ErrorActionPreference = "Stop"',
    '$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$RepoDir = if ($env:YIVE_REPO_DIR) { $env:YIVE_REPO_DIR } else { Split-Path -Parent $ScriptDir }',
    `pnpm -C "$RepoDir" smoke:relay-domain -- --domain ${domainHost} --android-package ${androidPackage} --android-sha256 ${sha256Fingerprint}`,
    '',
  ].join('\r\n')

  const gitignore = [
    '# Generated Android TWA build outputs and local signing secrets',
    '.gradle/',
    'build/',
    'app/build/',
    '*.apk',
    '*.aab',
    '*.apks',
    '*.idsig',
    '*.jks',
    '*.keystore',
    'keystore.properties',
    'local.properties',
    'signing.properties',
    '',
  ].join('\n')

  const config = {
    android_package: androidPackage,
    assetlinks_url: assetLinksUrl,
    bubblewrap_init: bubblewrapInit,
    bubblewrap_validate: bubblewrapValidate,
    generated_static_dir: staticDir,
    manifest_url: manifestUrl,
    mobile_start_url: mobileUrl,
    origin,
  }

  return {
    config,
    gitignore,
    installPowerShellScript,
    installScript,
    powershellScript,
    readme,
    releaseCheckPowerShellScript,
    releaseCheckScript,
    shellScript,
    verifyDevicePowerShellScript,
    verifyDeviceScript,
  }
}

export const prepareAndroidTwa = async ({
  androidPackage,
  domain,
  outDir,
  sha256Fingerprint,
  staticDir,
}) => {
  const resolvedOutDir = resolve(outDir)
  await mkdir(resolvedOutDir, { recursive: true })
  const assetLinksPath = await writeAndroidAssetLinks({
    outDir: staticDir,
    packageName: androidPackage,
    sha256Fingerprint,
  })
  const kit = createAndroidTwaPackage({
    androidPackage,
    domain,
    sha256Fingerprint,
    staticDir: resolve(staticDir),
  })

  await writeGeneratedFile(resolve(resolvedOutDir, 'README.md'), kit.readme)
  await writeGeneratedFile(
    resolve(resolvedOutDir, 'twa-package.json'),
    `${JSON.stringify(kit.config, null, 2)}\n`
  )
  await writeGeneratedFile(resolve(resolvedOutDir, '.gitignore'), kit.gitignore)
  await writeGeneratedFile(resolve(resolvedOutDir, 'build-twa.sh'), kit.shellScript)
  await writeGeneratedFile(resolve(resolvedOutDir, 'build-twa.ps1'), kit.powershellScript)
  await writeGeneratedFile(resolve(resolvedOutDir, 'install-twa.sh'), kit.installScript)
  await writeGeneratedFile(resolve(resolvedOutDir, 'install-twa.ps1'), kit.installPowerShellScript)
  await writeGeneratedFile(resolve(resolvedOutDir, 'verify-device.sh'), kit.verifyDeviceScript)
  await writeGeneratedFile(
    resolve(resolvedOutDir, 'verify-device.ps1'),
    kit.verifyDevicePowerShellScript
  )
  await writeGeneratedFile(resolve(resolvedOutDir, 'check-release.sh'), kit.releaseCheckScript)
  await writeGeneratedFile(
    resolve(resolvedOutDir, 'check-release.ps1'),
    kit.releaseCheckPowerShellScript
  )

  return {
    assetLinksPath,
    outDir: resolvedOutDir,
    packageConfigPath: resolve(resolvedOutDir, 'twa-package.json'),
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const result = await prepareAndroidTwa({
    androidPackage: requireFlag(argv, '--android-package'),
    domain: requireFlag(argv, '--domain'),
    outDir: requireFlag(argv, '--out-dir'),
    sha256Fingerprint: requireFlag(argv, '--android-sha256'),
    staticDir: requireFlag(argv, '--static-dir'),
  })
  console.log(`Android TWA package prepared: ${result.outDir}`)
  console.log(`Digital Asset Links written: ${result.assetLinksPath}`)
  console.log(`Package config written: ${basename(result.packageConfigPath)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
