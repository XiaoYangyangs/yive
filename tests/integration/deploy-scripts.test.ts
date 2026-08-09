import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { checkAndroidReleaseReadiness } from '../../deploy/check-android-release-readiness.mjs'
import { validateAndroidAssetLinks } from '../../deploy/check-domain-readiness.mjs'
import { prepareAndroidTwa } from '../../deploy/prepare-android-twa.mjs'
import {
  fingerprintCertificateBytes,
  formatSha256Fingerprint,
  parseKeytoolSha256,
  printAndroidCertSha256,
} from '../../deploy/print-android-cert-sha256.mjs'
import { verifyAndroidTwaKit } from '../../deploy/verify-android-twa-kit.mjs'
import { writeAndroidAssetLinks } from '../../deploy/write-android-assetlinks.mjs'

const testWithPosixBash = process.platform === 'win32' ? test.skip : test
const testWithWindowsPowerShell = process.platform === 'win32' ? test : test.skip

describe('deploy scripts', () => {
  test('windows desktop relay supervisor requires local runtime before advertising desktop', () => {
    const script = readFileSync('deploy/run-windows-desktop-relay.ps1', 'utf8')

    expect(script).toContain('"--require-runtime"')
  })

  test('relay production env template enables desktop-bound device tokens', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
    const template = readFileSync('deploy/relay.env.example', 'utf8')
    const checker = readFileSync('deploy/check-relay-config.sh', 'utf8')
    const deploy = readFileSync('deploy/deploy-relay.sh', 'utf8')
    const rollback = readFileSync('deploy/rollback-relay.sh', 'utf8')

    expect(packageJson.scripts['mobile:android:assetlinks']).toBe(
      'node deploy/write-android-assetlinks.mjs'
    )
    expect(packageJson.scripts['mobile:android:check']).toBe(
      'node deploy/check-android-release-readiness.mjs'
    )
    expect(packageJson.scripts['mobile:android:fingerprint']).toBe(
      'node deploy/print-android-cert-sha256.mjs'
    )
    expect(packageJson.scripts['mobile:android:twa']).toBe('node deploy/prepare-android-twa.mjs')
    expect(packageJson.scripts['mobile:android:verify']).toBe(
      'node deploy/verify-android-twa-kit.mjs'
    )
    expect(template).toContain('YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1')
    expect(template).toContain('YIVE_RELAY_PUBLIC_URL=http://<server-ip>:4020')
    expect(checker).toContain('YIVE_RELAY_REQUIRE_DESKTOP_BINDING must be 1')
    expect(checker).toContain('YIVE_RELAY_PUBLIC_URL must start with http:// or https://')
    expect(readFileSync('deploy/README.zh-CN.md', 'utf8')).toContain(
      '/health.deployment.public_url_configured'
    )
    expect(readFileSync('deploy/README.zh-CN.md', 'utf8')).toContain('mobile:android:assetlinks')
    expect(readFileSync('deploy/README.zh-CN.md', 'utf8')).toContain('mobile:android:fingerprint')
    expect(readFileSync('deploy/README.zh-CN.md', 'utf8')).toContain('mobile:android:twa')
    expect(readFileSync('deploy/README.zh-CN.md', 'utf8')).toContain('--android-package')
    expect(deploy).toContain('smoke-relay.mjs')
    expect(rollback).toContain('smoke-relay.mjs')
  })

  test('relay deploy and rollback run public smoke when configured', () => {
    for (const scriptPath of ['deploy/deploy-relay.sh', 'deploy/rollback-relay.sh']) {
      const script = readFileSync(scriptPath, 'utf8')

      expect(script).toMatch(/ENV_FILE="\$\{YIVE_RELAY_ENV_FILE:-\/etc\/yive\/relay\.env\}"/u)
      expect(script).toContain('source "$ENV_FILE"')
      expect(script).toContain('YIVE_RELAY_PUBLIC_URL')
      expect(script).toContain(
        'node "$APP_DIR/deploy/smoke-relay.mjs" --server "$YIVE_RELAY_PUBLIC_URL"'
      )
      expect(script).toContain('yive relay checklist --server \\"$YIVE_RELAY_PUBLIC_URL\\"')
      expect(script).toMatch(/YIVE_RELAY_ADMIN_TOKEN="\$\{YIVE_RELAY_ADMIN_TOKEN:-\}"/u)
    }
  })

  test('domain readiness validates Android asset links for TWA packaging', () => {
    const assetLinks = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.yive',
          sha256_cert_fingerprints: [
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
          ],
        },
      },
    ]

    expect(() =>
      validateAndroidAssetLinks(assetLinks, {
        packageName: 'com.example.yive',
        sha256Fingerprint:
          'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      })
    ).not.toThrow()

    expect(() =>
      validateAndroidAssetLinks(assetLinks, {
        packageName: 'xin.yive.wrong',
        sha256Fingerprint:
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      })
    ).toThrow(/does not authorize Android package/u)
  })

  test('extracts Android release certificate SHA-256 fingerprints', () => {
    expect(formatSha256Fingerprint(Buffer.from([0, 1, 10, 255]))).toBe('00:01:0A:FF')
    expect(
      parseKeytoolSha256(`
Certificate fingerprints:
         SHA1: 11:22
         SHA256: aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99
`)
    ).toBe(
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
    )

    expect(fingerprintCertificateBytes(Buffer.from([1, 2, 3]))).toBe(
      '03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81'
    )
  })

  test('rejects non-certificate files for Android certificate fingerprinting', async () => {
    await expect(
      printAndroidCertSha256({ certPath: 'deploy/assetlinks.android.example.json' })
    ).rejects.toThrow('certificate file must use .pem, .cer, .crt, or .der')
  })

  test('writes Android asset links into a static directory for TWA packaging', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-assetlinks-test-'))
    const fingerprint =
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

    try {
      const outputPath = await writeAndroidAssetLinks({
        outDir: tempDir,
        packageName: 'com.example.yive',
        sha256Fingerprint: fingerprint.toLowerCase(),
      })
      const assetLinks = JSON.parse(readFileSync(outputPath, 'utf8')) as unknown

      expect(outputPath).toBe(join(tempDir, '.well-known', 'assetlinks.json'))
      expect(readFileSync(outputPath, 'utf8')).toContain('"package_name": "com.example.yive"')
      validateAndroidAssetLinks(assetLinks, {
        packageName: 'com.example.yive',
        sha256Fingerprint: fingerprint,
      })
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test('prepares an Android TWA package kit without signing secrets', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-twa-test-'))
    const staticDir = join(tempDir, 'web-dist')
    const outDir = join(tempDir, 'android-twa')
    const fingerprint =
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

    try {
      const result = await prepareAndroidTwa({
        androidPackage: 'com.example.yive',
        domain: 'https://relay.example.com/mobile?relay=1',
        outDir,
        sha256Fingerprint: fingerprint,
        staticDir,
      })
      const config = JSON.parse(readFileSync(join(outDir, 'twa-package.json'), 'utf8')) as Record<
        string,
        unknown
      >
      const readme = readFileSync(join(outDir, 'README.md'), 'utf8')
      const buildScript = readFileSync(join(outDir, 'build-twa.sh'), 'utf8')
      const installScript = readFileSync(join(outDir, 'install-twa.sh'), 'utf8')
      const installPowerShell = readFileSync(join(outDir, 'install-twa.ps1'), 'utf8')
      const verifyDeviceScript = readFileSync(join(outDir, 'verify-device.sh'), 'utf8')
      const verifyDevicePowerShell = readFileSync(join(outDir, 'verify-device.ps1'), 'utf8')
      const releaseCheckScript = readFileSync(join(outDir, 'check-release.sh'), 'utf8')
      const releaseCheckPowerShell = readFileSync(join(outDir, 'check-release.ps1'), 'utf8')
      const gitignore = readFileSync(join(outDir, '.gitignore'), 'utf8')

      expect(result.assetLinksPath).toBe(join(staticDir, '.well-known', 'assetlinks.json'))
      expect(config).toMatchObject({
        android_package: 'com.example.yive',
        bubblewrap_init:
          'bubblewrap init --manifest=https://relay.example.com/manifest.webmanifest',
        manifest_url: 'https://relay.example.com/manifest.webmanifest',
        mobile_start_url: 'https://relay.example.com/mobile?relay=1',
        origin: 'https://relay.example.com',
      })
      expect(readme).toContain('Trusted Web Activity')
      expect(readme).toContain('Do not commit release keystores or signing passwords')
      expect(readme).toContain('bubblewrap validate --url=https://relay.example.com/mobile?relay=1')
      expect(readme).toContain('check-release.sh')
      expect(readme).toContain('install-twa.sh')
      expect(readme).toContain('verify-device.sh')
      expect(readme).not.toContain('keystorePassword')
      expect(buildScript).toContain(
        'bubblewrap validate --url=https://relay.example.com/mobile?relay=1'
      )
      expect(buildScript).toContain('./install-twa.sh')
      expect(buildScript).toContain('./verify-device.sh')
      expect(installScript).toContain('adb install -r "$APK"')
      expect(installPowerShell.trimStart().startsWith('param([string]$Apk')).toBe(true)
      expect(installScript).toContain('adb shell monkey -p com.example.yive 1')
      expect(installPowerShell).toContain('adb install -r $Apk')
      expect(installPowerShell).toContain('adb shell monkey -p com.example.yive 1')
      expect(verifyDeviceScript).toContain('adb devices')
      expect(verifyDeviceScript).toContain('pm list packages com.example.yive')
      expect(verifyDeviceScript).toContain('adb shell monkey -p com.example.yive 1')
      expect(verifyDeviceScript).toContain('https://relay.example.com/mobile?relay=1')
      expect(verifyDevicePowerShell).toContain('adb devices')
      expect(verifyDevicePowerShell).toContain('pm list packages com.example.yive')
      expect(verifyDevicePowerShell).toContain('adb shell monkey -p com.example.yive 1')
      expect(verifyDevicePowerShell).toContain('https://relay.example.com/mobile?relay=1')
      expect(releaseCheckScript).toContain('pnpm -C "$REPO_DIR" smoke:relay-domain')
      expect(releaseCheckScript).toContain('--domain relay.example.com')
      expect(releaseCheckScript).toContain('--android-package com.example.yive')
      expect(releaseCheckScript).toContain(`--android-sha256 ${fingerprint}`)
      expect(releaseCheckPowerShell).toContain('pnpm -C "$RepoDir" smoke:relay-domain')
      expect(releaseCheckPowerShell).toContain('--domain relay.example.com')
      expect(gitignore).toContain('*.aab')
      expect(gitignore).toContain('*.jks')
      expect(gitignore).toContain('keystore.properties')
      expect(gitignore).toContain('local.properties')
      expect(readFileSync(join(outDir, 'install-twa.sh'), 'utf8')).toContain(
        'app-release-signed.apk'
      )
      expect(readFileSync(join(outDir, 'verify-device.sh'), 'utf8')).toContain(
        'Android device check passed for com.example.yive'
      )
      expect(readFileSync(join(staticDir, '.well-known', 'assetlinks.json'), 'utf8')).toContain(
        '"package_name": "com.example.yive"'
      )
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test('verifies an Android TWA package kit against generated static assets', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-twa-verify-test-'))
    const staticDir = join(tempDir, 'web-dist')
    const outDir = join(tempDir, 'android-twa')
    const fingerprint =
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

    try {
      mkdirSync(staticDir, { recursive: true })
      writeFileSync(
        join(staticDir, 'manifest.webmanifest'),
        JSON.stringify({
          display: 'standalone',
          icons: [{ purpose: 'maskable', src: '/icons/icon-512-maskable.png' }],
          start_url: '/mobile?relay=1',
        }),
        'utf8'
      )
      writeFileSync(join(staticDir, 'sw.js'), "self.addEventListener('install', () => {})\n")
      await prepareAndroidTwa({
        androidPackage: 'com.example.yive',
        domain: 'https://relay.example.com',
        outDir,
        sha256Fingerprint: fingerprint,
        staticDir,
      })

      const result = await verifyAndroidTwaKit({
        androidPackage: 'com.example.yive',
        domain: 'https://relay.example.com/mobile?relay=1',
        sha256Fingerprint: fingerprint,
        staticDir,
        twaDir: outDir,
      })

      expect(result).toMatchObject({
        androidPackage: 'com.example.yive',
        mobileUrl: 'https://relay.example.com/mobile?relay=1',
        origin: 'https://relay.example.com',
      })
      await expect(
        verifyAndroidTwaKit({
          androidPackage: 'xin.yive.wrong',
          domain: 'https://relay.example.com',
          sha256Fingerprint: fingerprint,
          staticDir,
          twaDir: outDir,
        })
      ).rejects.toThrow(/does not authorize Android package/u)

      writeFileSync(
        join(outDir, 'install-twa.ps1'),
        '$ErrorActionPreference = "Stop"\r\nparam()\r\n'
      )
      await expect(
        verifyAndroidTwaKit({
          androidPackage: 'com.example.yive',
          domain: 'https://relay.example.com',
          sha256Fingerprint: fingerprint,
          staticDir,
          twaDir: outDir,
        })
      ).rejects.toThrow('install-twa.ps1 must start with param')
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test('runs the local Android release readiness gate without domain checks', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-android-release-check-test-'))
    const staticDir = join(tempDir, 'web-dist')
    const outDir = join(tempDir, 'android-twa')
    const fingerprint =
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

    try {
      mkdirSync(staticDir, { recursive: true })
      writeFileSync(
        join(staticDir, 'manifest.webmanifest'),
        JSON.stringify({
          display: 'standalone',
          icons: [{ purpose: 'maskable', src: '/icons/icon-512-maskable.png' }],
          start_url: '/mobile?relay=1',
        }),
        'utf8'
      )
      writeFileSync(join(staticDir, 'sw.js'), "self.addEventListener('install', () => {})\n")

      const result = await checkAndroidReleaseReadiness({
        androidPackage: 'com.example.yive',
        domain: 'https://relay.example.com/mobile?relay=1',
        outDir,
        sha256Fingerprint: fingerprint,
        staticDir,
      })

      expect(result).toMatchObject({
        checkDomain: false,
        host: 'relay.example.com',
        origin: 'https://relay.example.com',
        twaDir: outDir,
      })
      expect(readFileSync(join(staticDir, '.well-known', 'assetlinks.json'), 'utf8')).toContain(
        '"package_name": "com.example.yive"'
      )
      expect(readFileSync(join(outDir, 'twa-package.json'), 'utf8')).toContain(
        '"mobile_start_url": "https://relay.example.com/mobile?relay=1"'
      )
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test('rejects HTTP origins for Android TWA packaging', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-twa-http-test-'))
    try {
      await expect(
        prepareAndroidTwa({
          androidPackage: 'com.example.yive',
          domain: 'http://203.0.113.10',
          outDir: join(tempDir, 'android-twa'),
          sha256Fingerprint:
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
          staticDir: join(tempDir, 'web-dist'),
        })
      ).rejects.toThrow('Android TWA packaging requires an HTTPS origin')
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  testWithPosixBash('relay config check reports Windows CRLF env files clearly', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-deploy-test-'))
    const envFile = join(tempDir, 'relay.env')

    try {
      writeFileSync(envFile, 'YIVE_RELAY_PORT=4020\r\n', 'utf8')

      const result = spawnSync('bash', ['deploy/check-relay-config.sh'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          YIVE_RELAY_ENV_FILE: envFile,
        },
      })

      expect(result.status).toBe(64)
      expect(result.stderr).toContain('contains Windows CRLF line endings')
      expect(result.stderr).toContain("sudo sed -i 's/\\r$//'")
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  testWithPosixBash('relay config check rejects production without desktop binding', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-deploy-test-'))
    const envFile = join(tempDir, 'relay.env')
    const appDir = join(tempDir, 'app')
    const staticDir = join(appDir, 'web', 'dist')

    try {
      writeFileSync(
        envFile,
        [
          'YIVE_RELAY_PORT=4020',
          'YIVE_RELAY_ADMIN_TOKEN=test-admin-token',
          `YIVE_RELAY_PAIRING_STORE=${join(tempDir, 'relay-pairings.json')}`,
          `YIVE_RELAY_STATIC_DIR=${staticDir}`,
          'YIVE_RELAY_HEARTBEAT_INTERVAL_MS=30000',
          'YIVE_RELAY_HEARTBEAT_TIMEOUT_MS=75000',
          'YIVE_RELAY_REQUIRE_DESKTOP_BINDING=0',
          '',
        ].join('\n'),
        'utf8'
      )
      mkdirSync(join(appDir, 'dist', 'src', 'cli'), { recursive: true })
      mkdirSync(staticDir, { recursive: true })
      writeFileSync(join(appDir, 'dist', 'src', 'cli', 'hive.js'), 'console.log("hive")\n')
      writeFileSync(join(staticDir, 'index.html'), '<div id="root"></div>\n')

      const result = spawnSync('bash', ['deploy/check-relay-config.sh'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          YIVE_RELAY_APP_DIR: appDir,
          YIVE_RELAY_ENV_FILE: envFile,
        },
      })

      expect(result.status).toBe(64)
      expect(result.stderr).toContain('YIVE_RELAY_REQUIRE_DESKTOP_BINDING must be 1')
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  testWithPosixBash('relay config check rejects malformed public smoke URLs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yive-deploy-test-'))
    const envFile = join(tempDir, 'relay.env')
    const appDir = join(tempDir, 'app')
    const staticDir = join(appDir, 'web', 'dist')

    try {
      writeFileSync(
        envFile,
        [
          'YIVE_RELAY_PORT=4020',
          'YIVE_RELAY_ADMIN_TOKEN=test-admin-token',
          `YIVE_RELAY_PAIRING_STORE=${join(tempDir, 'relay-pairings.json')}`,
          `YIVE_RELAY_STATIC_DIR=${staticDir}`,
          'YIVE_RELAY_HEARTBEAT_INTERVAL_MS=30000',
          'YIVE_RELAY_HEARTBEAT_TIMEOUT_MS=75000',
          'YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1',
          'YIVE_RELAY_PUBLIC_URL=relay example',
          '',
        ].join('\n'),
        'utf8'
      )
      mkdirSync(join(appDir, 'dist', 'src', 'cli'), { recursive: true })
      mkdirSync(staticDir, { recursive: true })
      writeFileSync(join(appDir, 'dist', 'src', 'cli', 'hive.js'), 'console.log("hive")\n')
      writeFileSync(join(staticDir, 'index.html'), '<div id="root"></div>\n')

      const result = spawnSync('bash', ['deploy/check-relay-config.sh'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          YIVE_RELAY_APP_DIR: appDir,
          YIVE_RELAY_ENV_FILE: envFile,
        },
      })

      expect(result.status).toBe(64)
      expect(result.stderr).toContain('YIVE_RELAY_PUBLIC_URL must start with http:// or https://')
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  testWithWindowsPowerShell(
    'windows desktop relay check accepts local request timeout config',
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'yive-desktop-relay-test-'))
      const envFile = join(tempDir, 'desktop-relay.env')
      const statusFile = join(tempDir, 'status.json')

      try {
        writeFileSync(
          envFile,
          [
            'YIVE_RELAY_SERVER=https://relay.example',
            'YIVE_RELAY_TOKEN=test-token',
            'YIVE_RELAY_DEVICE_ID=desktop-test',
            'YIVE_RUNTIME_PORT=3001',
            'YIVE_RELAY_RUNTIME_URL=http://127.0.0.1:3001',
            'YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS=12345',
            `YIVE_RELAY_STATUS_FILE=${statusFile}`,
            '',
          ].join('\n'),
          'utf8'
        )

        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'deploy/run-windows-desktop-relay.ps1',
            '-EnvFile',
            envFile,
            '-RepoDir',
            process.cwd(),
            '-Check',
            '-SkipRelayCheck',
            '-SkipRuntimeCheck',
          ],
          { encoding: 'utf8' }
        )

        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Local request timeout: 12345ms')
        const status = JSON.parse(readFileSync(statusFile, 'utf8').replace(/^\uFEFF/u, ''))
        expect(status).toMatchObject({
          device_id: 'desktop-test',
          local_request_timeout_ms: 12345,
          runtime_url: 'http://127.0.0.1:3001',
        })
      } finally {
        rmSync(tempDir, { force: true, recursive: true })
      }
    }
  )

  testWithWindowsPowerShell(
    'windows desktop relay check reports unreachable local runtime clearly',
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'yive-desktop-relay-test-'))
      const envFile = join(tempDir, 'desktop-relay.env')

      try {
        writeFileSync(
          envFile,
          [
            'YIVE_RELAY_SERVER=https://relay.example',
            'YIVE_RELAY_TOKEN=test-token',
            'YIVE_RELAY_DEVICE_ID=desktop-test',
            'YIVE_RUNTIME_PORT=1',
            'YIVE_RELAY_RUNTIME_URL=http://127.0.0.1:1',
            'YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS=1000',
            '',
          ].join('\n'),
          'utf8'
        )

        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'deploy/run-windows-desktop-relay.ps1',
            '-EnvFile',
            envFile,
            '-RepoDir',
            process.cwd(),
            '-Check',
            '-SkipRelayCheck',
          ],
          { encoding: 'utf8' }
        )

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Local Yive runtime check failed')
        expect(result.stderr.replace(/\s/gu, '')).toContain(
          'StartlocalyiveorsetYIVE_RELAY_MANAGE_RUNTIME=1'
        )
      } finally {
        rmSync(tempDir, { force: true, recursive: true })
      }
    }
  )

  testWithWindowsPowerShell(
    'windows desktop relay check rejects invalid local request timeout config',
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'yive-desktop-relay-test-'))
      const envFile = join(tempDir, 'desktop-relay.env')

      try {
        writeFileSync(
          envFile,
          [
            'YIVE_RELAY_SERVER=https://relay.example',
            'YIVE_RELAY_TOKEN=test-token',
            'YIVE_RELAY_DEVICE_ID=desktop-test',
            'YIVE_RUNTIME_PORT=3001',
            'YIVE_RELAY_RUNTIME_URL=http://127.0.0.1:3001',
            'YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS=0',
            '',
          ].join('\n'),
          'utf8'
        )

        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'deploy/run-windows-desktop-relay.ps1',
            '-EnvFile',
            envFile,
            '-RepoDir',
            process.cwd(),
            '-Check',
            '-SkipRelayCheck',
          ],
          { encoding: 'utf8' }
        )

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(
          'YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS must be a positive integer'
        )
      } finally {
        rmSync(tempDir, { force: true, recursive: true })
      }
    }
  )
})
