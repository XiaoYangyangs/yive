#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validateAndroidAssetLinks } from './check-domain-readiness.mjs'

const usage = `Usage: node deploy/verify-android-twa-kit.mjs --static-dir <web-dist> --twa-dir <android-twa-dir> --domain <https-origin> --android-package <id> --android-sha256 <fingerprint>

Example:
  node deploy/verify-android-twa-kit.mjs --static-dir web/dist --twa-dir android-twa --domain https://relay.example.com --android-package com.example.yive --android-sha256 AA:BB:...
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
  if (url.protocol !== 'https:') throw new Error('Android TWA verification requires HTTPS')
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.origin
}

const readJsonFile = async (path, label) => {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

const assertFileExists = async (path, label) => {
  try {
    await access(path)
  } catch {
    throw new Error(`${label} is missing: ${path}`)
  }
}

const assertIncludes = (content, needle, label) => {
  if (!content.includes(needle)) throw new Error(`${label} is missing ${needle}`)
}

export const verifyAndroidTwaKit = async ({
  androidPackage,
  domain,
  sha256Fingerprint,
  staticDir,
  twaDir,
}) => {
  const origin = normalizeHttpsOrigin(domain)
  const host = new URL(origin).host
  const resolvedStaticDir = resolve(staticDir)
  const resolvedTwaDir = resolve(twaDir)
  const manifestUrl = `${origin}/manifest.webmanifest`
  const mobileUrl = `${origin}/mobile?relay=1`
  const assetLinksUrl = `${origin}/.well-known/assetlinks.json`

  const manifestPath = resolve(resolvedStaticDir, 'manifest.webmanifest')
  const serviceWorkerPath = resolve(resolvedStaticDir, 'sw.js')
  const assetLinksPath = resolve(resolvedStaticDir, '.well-known', 'assetlinks.json')
  const packageConfigPath = resolve(resolvedTwaDir, 'twa-package.json')
  const readmePath = resolve(resolvedTwaDir, 'README.md')
  const buildShPath = resolve(resolvedTwaDir, 'build-twa.sh')
  const buildPs1Path = resolve(resolvedTwaDir, 'build-twa.ps1')
  const installShPath = resolve(resolvedTwaDir, 'install-twa.sh')
  const installPs1Path = resolve(resolvedTwaDir, 'install-twa.ps1')
  const verifyDeviceShPath = resolve(resolvedTwaDir, 'verify-device.sh')
  const verifyDevicePs1Path = resolve(resolvedTwaDir, 'verify-device.ps1')
  const checkShPath = resolve(resolvedTwaDir, 'check-release.sh')
  const checkPs1Path = resolve(resolvedTwaDir, 'check-release.ps1')
  const gitignorePath = resolve(resolvedTwaDir, '.gitignore')

  const manifest = await readJsonFile(manifestPath, 'manifest.webmanifest')
  if (manifest.start_url !== '/mobile?relay=1') {
    throw new Error('manifest.webmanifest start_url must be /mobile?relay=1')
  }
  if (manifest.display !== 'standalone') {
    throw new Error('manifest.webmanifest display must be standalone')
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  if (
    !icons.some(
      (icon) =>
        icon &&
        typeof icon.src === 'string' &&
        icon.src.includes('/icons/icon-512-maskable.png') &&
        String(icon.purpose ?? '').includes('maskable')
    )
  ) {
    throw new Error('manifest.webmanifest is missing /icons/icon-512-maskable.png maskable icon')
  }

  const serviceWorker = await readFile(serviceWorkerPath, 'utf8')
  assertIncludes(serviceWorker, 'self.addEventListener', 'sw.js')

  const assetLinks = await readJsonFile(assetLinksPath, 'assetlinks.json')
  validateAndroidAssetLinks(assetLinks, {
    packageName: androidPackage,
    sha256Fingerprint,
  })

  const config = await readJsonFile(packageConfigPath, 'twa-package.json')
  const expectedConfig = {
    android_package: androidPackage,
    assetlinks_url: assetLinksUrl,
    bubblewrap_init: `bubblewrap init --manifest=${manifestUrl}`,
    bubblewrap_validate: `bubblewrap validate --url=${mobileUrl}`,
    manifest_url: manifestUrl,
    mobile_start_url: mobileUrl,
    origin,
  }
  for (const [key, value] of Object.entries(expectedConfig)) {
    if (config[key] !== value) {
      throw new Error(`twa-package.json ${key} must be ${value}`)
    }
  }

  await assertFileExists(readmePath, 'Android TWA README')
  await assertFileExists(buildShPath, 'Android TWA build-twa.sh')
  await assertFileExists(buildPs1Path, 'Android TWA build-twa.ps1')
  await assertFileExists(installShPath, 'Android TWA install-twa.sh')
  await assertFileExists(installPs1Path, 'Android TWA install-twa.ps1')
  await assertFileExists(verifyDeviceShPath, 'Android TWA verify-device.sh')
  await assertFileExists(verifyDevicePs1Path, 'Android TWA verify-device.ps1')
  await assertFileExists(checkShPath, 'Android TWA check-release.sh')
  await assertFileExists(checkPs1Path, 'Android TWA check-release.ps1')
  await assertFileExists(gitignorePath, 'Android TWA .gitignore')

  const readme = await readFile(readmePath, 'utf8')
  const buildSh = await readFile(buildShPath, 'utf8')
  const buildPs1 = await readFile(buildPs1Path, 'utf8')
  const installSh = await readFile(installShPath, 'utf8')
  const installPs1 = await readFile(installPs1Path, 'utf8')
  const verifyDeviceSh = await readFile(verifyDeviceShPath, 'utf8')
  const verifyDevicePs1 = await readFile(verifyDevicePs1Path, 'utf8')
  const checkSh = await readFile(checkShPath, 'utf8')
  const checkPs1 = await readFile(checkPs1Path, 'utf8')
  const gitignore = await readFile(gitignorePath, 'utf8')

  for (const [label, content] of [
    ['README.md', readme],
    ['build-twa.sh', buildSh],
    ['build-twa.ps1', buildPs1],
  ]) {
    assertIncludes(content, `bubblewrap validate --url=${mobileUrl}`, label)
    assertIncludes(content, `bubblewrap init --manifest=${manifestUrl}`, label)
  }
  for (const [label, content] of [
    ['check-release.sh', checkSh],
    ['check-release.ps1', checkPs1],
  ]) {
    assertIncludes(content, '--android-package', label)
    assertIncludes(content, androidPackage, label)
    assertIncludes(content, '--android-sha256', label)
    assertIncludes(content, sha256Fingerprint, label)
    assertIncludes(content, `--domain ${host}`, label)
  }
  if (!installPs1.trimStart().startsWith('param([string]$Apk')) {
    throw new Error('install-twa.ps1 must start with param([string]$Apk...) before commands')
  }
  for (const [label, content] of [
    ['install-twa.sh', installSh],
    ['install-twa.ps1', installPs1],
  ]) {
    assertIncludes(content, 'adb install -r', label)
    assertIncludes(content, `monkey -p ${androidPackage} 1`, label)
  }
  for (const [label, content] of [
    ['verify-device.sh', verifyDeviceSh],
    ['verify-device.ps1', verifyDevicePs1],
  ]) {
    assertIncludes(content, 'adb devices', label)
    assertIncludes(content, `pm list packages ${androidPackage}`, label)
    assertIncludes(content, `monkey -p ${androidPackage} 1`, label)
    assertIncludes(content, mobileUrl, label)
  }
  for (const secretPattern of [
    '*.jks',
    '*.keystore',
    'keystore.properties',
    'signing.properties',
  ]) {
    assertIncludes(gitignore, secretPattern, '.gitignore')
  }

  return {
    androidPackage,
    assetLinksPath,
    manifestPath,
    mobileUrl,
    origin,
    packageConfigPath,
    twaDir: resolvedTwaDir,
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const result = await verifyAndroidTwaKit({
    androidPackage: requireFlag(argv, '--android-package'),
    domain: requireFlag(argv, '--domain'),
    sha256Fingerprint: requireFlag(argv, '--android-sha256'),
    staticDir: requireFlag(argv, '--static-dir'),
    twaDir: requireFlag(argv, '--twa-dir'),
  })
  console.log(`Android TWA kit verified: ${result.twaDir}`)
  console.log(`Origin: ${result.origin}`)
  console.log(`Mobile start URL: ${result.mobileUrl}`)
  console.log(`Package: ${result.androidPackage}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
