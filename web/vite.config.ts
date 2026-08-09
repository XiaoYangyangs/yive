import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

import { buildSw } from './src/pwa/build-sw.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')) as {
  version: string
}

const runtimePort = Number.parseInt(process.env.HIVE_RUNTIME_PORT ?? '4010', 10)
const webPort = Number.parseInt(process.env.HIVE_WEB_PORT ?? '5180', 10)
const webHost = process.env.HIVE_WEB_HOST ?? '127.0.0.1'
const swVersion =
  process.env.HIVE_SW_VERSION ??
  `${packageJson.version}-${process.env.HIVE_BUILD_ID ?? Date.now().toString(36)}`

export default defineConfig({
  plugins: [tailwindcss(), buildSw({ version: swVersion })],
  root: 'web',
  build: {
    outDir: 'dist',
  },
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${runtimePort}`,
        changeOrigin: true,
        headers: {
          Origin: `http://127.0.0.1:${runtimePort}`,
        },
      },
      '/ws': {
        target: `ws://127.0.0.1:${runtimePort}`,
        changeOrigin: true,
        headers: {
          Origin: `http://127.0.0.1:${runtimePort}`,
        },
        ws: true,
      },
    },
  },
})
