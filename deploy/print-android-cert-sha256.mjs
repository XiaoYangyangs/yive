#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const usage = `Usage:
  node deploy/print-android-cert-sha256.mjs --keystore <release.jks> --alias <alias> [--storepass <password>] [--keytool <path>]
  node deploy/print-android-cert-sha256.mjs --cert <release-cert.pem|cer|crt>

Examples:
  node deploy/print-android-cert-sha256.mjs --keystore android-twa/release.jks --alias yive
  node deploy/print-android-cert-sha256.mjs --cert release-cert.pem
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

export const formatSha256Fingerprint = (buffer) =>
  [...buffer].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')

export const parseKeytoolSha256 = (output) => {
  const match = output.match(/SHA256:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){31})/iu)
  if (!match?.[1]) {
    throw new Error('keytool output did not contain a SHA256 certificate fingerprint')
  }
  return match[1].toUpperCase()
}

const pemToDer = (text) => {
  const match = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/u)
  if (!match?.[1]) return null
  return Buffer.from(match[1].replace(/\s+/gu, ''), 'base64')
}

export const fingerprintCertificateBytes = (bytes) => {
  const text = bytes.toString('utf8')
  const der = text.includes('-----BEGIN CERTIFICATE-----') ? pemToDer(text) : Buffer.from(bytes)
  if (!der || der.length === 0) throw new Error('certificate file is empty or invalid')
  return formatSha256Fingerprint(createHash('sha256').update(der).digest())
}

const execFileAsync = (file, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolvePromise(`${stdout}\n${stderr}`)
    })
  })

export const printAndroidCertSha256 = async ({
  alias,
  certPath,
  keytool = 'keytool',
  keystorePath,
  storepass,
}) => {
  if (certPath) {
    const extension = extname(certPath).toLowerCase()
    if (!['.cer', '.crt', '.der', '.pem'].includes(extension)) {
      throw new Error('certificate file must use .pem, .cer, .crt, or .der')
    }
    const bytes = await readFile(certPath)
    return fingerprintCertificateBytes(bytes)
  }

  if (!keystorePath || !alias) throw new Error(usage)
  const args = ['-list', '-v', '-keystore', keystorePath, '-alias', alias]
  if (storepass) args.push('-storepass', storepass)
  return parseKeytoolSha256(await execFileAsync(keytool, args))
}

const main = async () => {
  const argv = process.argv.slice(2)
  const cert = readFlag(argv, '--cert')?.trim()
  const keystore = readFlag(argv, '--keystore')?.trim()
  if (cert && keystore) throw new Error('Use either --cert or --keystore, not both')
  const fingerprint = await printAndroidCertSha256({
    ...(cert ? { certPath: resolve(cert) } : {}),
    ...(keystore
      ? {
          alias: requireFlag(argv, '--alias'),
          keytool: readFlag(argv, '--keytool')?.trim() || 'keytool',
          keystorePath: resolve(keystore),
          ...(readFlag(argv, '--storepass') ? { storepass: readFlag(argv, '--storepass') } : {}),
        }
      : {}),
  })
  const source = cert ? extname(cert).replace(/^\./u, '').toUpperCase() || 'CERT' : 'KEYSTORE'
  console.log(`Android release certificate SHA-256 (${source}): ${fingerprint}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
