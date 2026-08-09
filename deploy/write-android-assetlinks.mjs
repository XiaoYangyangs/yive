#!/usr/bin/env node

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validateAndroidAssetLinks } from './check-domain-readiness.mjs'

const usage = `Usage: node deploy/write-android-assetlinks.mjs --out-dir <static-dir> --android-package <id> --android-sha256 <fingerprint>

Example:
  node deploy/write-android-assetlinks.mjs --out-dir web/dist --android-package com.example.yive --android-sha256 AA:BB:...
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

export const createAndroidAssetLinks = ({ packageName, sha256Fingerprint }) => {
  const assetLinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: [sha256Fingerprint.trim().toUpperCase()],
      },
    },
  ]
  validateAndroidAssetLinks(assetLinks, { packageName, sha256Fingerprint })
  return assetLinks
}

export const writeAndroidAssetLinks = async ({ outDir, packageName, sha256Fingerprint }) => {
  const wellKnownDir = resolve(outDir, '.well-known')
  const outputPath = resolve(wellKnownDir, 'assetlinks.json')
  const tempPath = `${outputPath}.tmp`
  const assetLinks = createAndroidAssetLinks({ packageName, sha256Fingerprint })
  await mkdir(wellKnownDir, { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(assetLinks, null, 2)}\n`, 'utf8')
  await rename(tempPath, outputPath)
  return outputPath
}

const main = async () => {
  const argv = process.argv.slice(2)
  const outDir = requireFlag(argv, '--out-dir')
  const packageName = requireFlag(argv, '--android-package')
  const sha256Fingerprint = requireFlag(argv, '--android-sha256')
  const outputPath = await writeAndroidAssetLinks({ outDir, packageName, sha256Fingerprint })
  console.log(`Android asset links written: ${outputPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
