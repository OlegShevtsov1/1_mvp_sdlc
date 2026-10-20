import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot, runScript, tempDir } from './support.ts'

const changelog = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

Minimum backend version: v0.2.0

### Added

- Login page.

## [0.1.1] - 2026-10-20

Minimum backend version: v0.1.0

### Fixed

- Header no longer overlaps the menu.

## [0.1.0] - 2026-10-17

Minimum backend version: v0.1.0

### Added

- Runtime config.
`

function notes(version: string, file = changelog) {
  const dir = tempDir('release-notes-')
  writeFileSync(join(dir, 'CHANGELOG.md'), file)
  return runScript('scripts/release-notes.sh', [version], {}, dir)
}

describe('scripts/release-notes.sh', () => {
  it('prints exactly the section of the tag, without its heading or the next section', () => {
    const result = notes('v0.1.1')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(
      'Minimum backend version: v0.1.0\n\n### Fixed\n\n- Header no longer overlaps the menu.\n',
    )
  })

  it('prints the last section up to the end of the file', () => {
    expect(notes('v0.1.0').stdout).toBe('Minimum backend version: v0.1.0\n\n### Added\n\n- Runtime config.\n')
  })

  it('prints the Unreleased section', () => {
    expect(notes('Unreleased').stdout).toBe('Minimum backend version: v0.2.0\n\n### Added\n\n- Login page.\n')
  })

  it('reads the file named by CHANGELOG_FILE', () => {
    const dir = tempDir('release-notes-file-')
    const file = join(dir, 'other.md')
    writeFileSync(file, changelog)
    const result = runScript('scripts/release-notes.sh', ['v0.1.0'], { CHANGELOG_FILE: file }, tempDir('empty-'))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('- Runtime config.')
  })

  it.each([
    ['an unknown version', 'v9.9.9', changelog],
    ['an empty section', 'v0.2.0', '# Changelog\n\n## [0.2.0] - 2026-11-01\n\n\n## [0.1.0] - 2026-10-17\n\n- x\n'],
    ['a malformed version', 'v0.1', changelog],
  ])('fails on %s', (_, version, file) => {
    const result = notes(version, file)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})

describe('CHANGELOG.md', () => {
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')

  it('keeps a changelog with an Unreleased section and the six categories', () => {
    expect(text).toContain('[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)')
    expect(text).toMatch(/^## \[Unreleased\]$/m)
    for (const category of ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']) {
      expect(text).toMatch(new RegExp(`^### ${category}$`, 'm'))
    }
  })

  it('declares the same minimum backend version as deploy/min-be-version', () => {
    const minimum = readFileSync(join(repoRoot, 'deploy', 'min-be-version'), 'utf8').trim()
    expect(minimum).toMatch(/^v\d+\.\d+\.\d+$/)
    const result = runScript('scripts/release-notes.sh', ['Unreleased'], {}, repoRoot)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`Minimum backend version: ${minimum}\n`)
  })
})
