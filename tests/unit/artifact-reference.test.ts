import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  haveSameArtifactFileIdentity,
  MAX_ARTIFACT_BYTES,
  normalizeArtifactReference,
  resolveArtifactReference,
} from '../../src/server/artifact-reference.js'

const tempDirs: string[] = []

const createWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'yive-artifact-reference-'))
  tempDirs.push(root)
  return root
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('Artifact reference policy', () => {
  test('compares large Windows file identities without number precision loss', () => {
    const firstInode = 14_918_173_767_281_355n
    const secondInode = 14_918_173_767_281_356n
    expect(Number(firstInode)).toBe(Number(secondInode))
    expect(
      haveSameArtifactFileIdentity({ dev: 1n, ino: firstInode }, { dev: 1n, ino: secondInode })
    ).toBe(false)
  })

  test('normalizes one existing Workspace-relative source file without exposing its absolute path', () => {
    const workspace = createWorkspace()
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'result.ts'), 'export const result = true\n')

    const artifact = resolveArtifactReference({
      reference: 'src\\.\\result.ts',
      workspacePath: workspace,
    })

    expect(artifact.reference).toBe('src/result.ts')
    expect(artifact.name).toBe('result.ts')
    expect(artifact.size).toBeGreaterThan(0)
    expect(isAbsolute(artifact.reference)).toBe(false)
  })

  test.each([
    ['absolute path', 'C:\\outside\\secret.txt'],
    ['POSIX absolute path', '/outside/secret.txt'],
    ['parent traversal', '../secret.txt'],
    ['embedded parent traversal', 'safe/../secret.txt'],
    ['credential directory', '.git/config'],
    ['case-insensitive credential directory', '.SSH/config'],
    ['credential file', '.env'],
  ])('rejects %s', (_label, reference) => {
    expect(() => normalizeArtifactReference(reference)).toThrow()
  })

  test('rejects a missing file, unsupported type, mismatched content, and oversized file', () => {
    const workspace = createWorkspace()
    writeFileSync(join(workspace, 'run.exe'), 'not executable')
    writeFileSync(join(workspace, 'fake.png'), 'not a png')
    const oversized = join(workspace, 'oversized.log')
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_ARTIFACT_BYTES + 1)

    expect(() =>
      resolveArtifactReference({ reference: 'missing.md', workspacePath: workspace })
    ).toThrow(/not found/u)
    expect(() =>
      resolveArtifactReference({ reference: 'run.exe', workspacePath: workspace })
    ).toThrow(/Unsupported Artifact type/u)
    expect(() =>
      resolveArtifactReference({ reference: 'fake.png', workspacePath: workspace })
    ).toThrow(/does not match/u)
    expect(() =>
      resolveArtifactReference({ reference: 'oversized.log', workspacePath: workspace })
    ).toThrow(/100MB/u)
  })

  test('rejects binary content anywhere in a text Artifact', () => {
    const workspace = createWorkspace()
    const reference = 'logs/late-binary.log'
    mkdirSync(join(workspace, 'logs'), { recursive: true })
    writeFileSync(
      join(workspace, reference),
      Buffer.concat([Buffer.alloc(9_000, 0x61), Buffer.from([0])])
    )

    expect(() => resolveArtifactReference({ reference, workspacePath: workspace })).toThrow(
      'Artifact text file contains binary content'
    )
  })

  test('rejects a directory junction that escapes the Workspace', () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    writeFileSync(join(outside, 'secret.md'), '# secret\n')
    symlinkSync(outside, join(workspace, 'linked'), 'junction')

    expect(() =>
      resolveArtifactReference({ reference: 'linked/secret.md', workspacePath: workspace })
    ).toThrow(/inside the Workspace/u)
  })
})
