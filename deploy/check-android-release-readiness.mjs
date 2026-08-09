#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { prepareAndroidTwa } from './prepare-android-twa.mjs'
import { verifyAndroidTwaKit } from './verify-android-twa-kit.mjs'

const usage = `Usage: node deploy/check-android-release-readiness.mjs --domain <https-origin> --static-dir <web-dist> --out-dir <android-twa-dir> --android-package <id> --android-sha256 <fingerprint> [--check-domain] [--server-ip <ip>]

Example:
  node deploy/check-android-release-readiness.mjs --domain https://relay.example.com --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 AA:BB:... --check-domain
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

const hasFlag = (argv, name) => argv.includes(name)

const normalizeHttpsOrigin = (value) => {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`
  const url = new URL(withScheme)
  if (url.protocol !== 'https:') {
    throw new Error('Android release readiness requires an HTTPS origin')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.origin
}

const runNodeScript = ({ args, script }) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${script} exited with ${code ?? 'unknown status'}`))
    })
  })

export const checkAndroidReleaseReadiness = async ({
  androidPackage,
  checkDomain = false,
  domain,
  outDir,
  serverIp,
  sha256Fingerprint,
  staticDir,
}) => {
  const origin = normalizeHttpsOrigin(domain)
  const host = new URL(origin).host

  const prepared = await prepareAndroidTwa({
    androidPackage,
    domain: origin,
    outDir,
    sha256Fingerprint,
    staticDir,
  })
  const verified = await verifyAndroidTwaKit({
    androidPackage,
    domain: origin,
    sha256Fingerprint,
    staticDir,
    twaDir: outDir,
  })

  if (checkDomain) {
    await runNodeScript({
      args: [
        '--domain',
        host,
        ...(serverIp ? ['--server-ip', serverIp] : []),
        '--android-package',
        androidPackage,
        '--android-sha256',
        sha256Fingerprint,
      ],
      script: resolve('deploy/check-domain-readiness.mjs'),
    })
  }

  return {
    assetLinksPath: prepared.assetLinksPath,
    checkDomain,
    host,
    origin,
    packageConfigPath: verified.packageConfigPath,
    twaDir: verified.twaDir,
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const result = await checkAndroidReleaseReadiness({
    androidPackage: requireFlag(argv, '--android-package'),
    checkDomain: hasFlag(argv, '--check-domain'),
    domain: requireFlag(argv, '--domain'),
    outDir: requireFlag(argv, '--out-dir'),
    serverIp: readFlag(argv, '--server-ip')?.trim(),
    sha256Fingerprint: requireFlag(argv, '--android-sha256'),
    staticDir: requireFlag(argv, '--static-dir'),
  })
  console.log(`Android release readiness ok: ${result.origin}`)
  console.log(`TWA kit: ${result.twaDir}`)
  console.log(`Digital Asset Links: ${result.assetLinksPath}`)
  console.log(`Package config: ${result.packageConfigPath}`)
  if (result.checkDomain) console.log(`Domain readiness checked: ${result.host}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
