import type { IncomingMessage } from 'node:http'

import { afterEach, describe, expect, test } from 'vitest'

import { getLocalRequestRejection } from '../../src/server/local-request-guard.js'

const requestWith = (input: { host?: string; origin?: string; remoteAddress?: string }) =>
  ({
    headers: {
      ...(input.host ? { host: input.host } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
    socket: {
      remoteAddress: input.remoteAddress,
    },
  }) as IncomingMessage

describe('local request guard', () => {
  afterEach(() => {
    delete process.env.HIVE_DEV_LAN
  })

  test('accepts localhost, loopback IPv4, and IPv4-mapped IPv6 clients', () => {
    expect(
      getLocalRequestRejection(requestWith({ host: 'localhost:5180', remoteAddress: '::1' }))
    ).toBeNull()
    expect(
      getLocalRequestRejection(requestWith({ host: '127.0.0.1:5180', remoteAddress: '127.0.0.1' }))
    ).toBeNull()
    expect(
      getLocalRequestRejection(
        requestWith({ host: '127.0.0.1:5180', remoteAddress: '::ffff:127.0.0.1' })
      )
    ).toBeNull()
  })

  test('rejects non-local remote addresses before trusting local Host headers', () => {
    expect(
      getLocalRequestRejection(requestWith({ host: '127.0.0.1:5180', remoteAddress: '10.0.0.5' }))
    ).toBe('non-local remote address')
  })

  test('accepts private LAN addresses only when dev LAN mode is enabled', () => {
    process.env.HIVE_DEV_LAN = '1'

    expect(
      getLocalRequestRejection(
        requestWith({
          host: '10.0.0.7:5180',
          origin: 'http://10.0.0.7:5180',
          remoteAddress: '10.0.0.5',
        })
      )
    ).toBeNull()
    expect(
      getLocalRequestRejection(
        requestWith({
          host: 'attacker.example',
          origin: 'https://attacker.example',
          remoteAddress: '203.0.113.5',
        })
      )
    ).toBe('non-local remote address')
  })

  test('accepts RFC1918 and link-local IPv4 LAN peers in dev LAN mode', () => {
    process.env.HIVE_DEV_LAN = '1'

    for (const address of [
      '10.1.2.3',
      '172.16.0.9',
      '172.31.255.9',
      '192.168.1.44',
      '169.254.1.2',
    ]) {
      expect(
        getLocalRequestRejection(
          requestWith({
            host: `${address}:4010`,
            origin: `http://${address}:4010`,
            remoteAddress: address,
          })
        )
      ).toBeNull()
    }
  })

  test('rejects public-looking Host and Origin even when dev LAN mode is enabled', () => {
    process.env.HIVE_DEV_LAN = '1'

    expect(
      getLocalRequestRejection(
        requestWith({
          host: '8.8.8.8:4010',
          origin: 'http://192.168.1.10:4010',
          remoteAddress: '192.168.1.44',
        })
      )
    ).toBe('non-local Host header')
    expect(
      getLocalRequestRejection(
        requestWith({
          host: '192.168.1.10:4010',
          origin: 'https://example.com',
          remoteAddress: '192.168.1.44',
        })
      )
    ).toBe('non-local Origin header')
  })
})
