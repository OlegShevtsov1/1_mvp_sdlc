import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, runScript, tempDir } from './support.ts'

interface Finding {
  severity: string
  path: string
  line: number
  title: string
  body: string
}

const marker = '<!-- ai-review -->'
let bin: string
let work: string

function result(findings: Finding[] | unknown, summary = 'Looks fine overall.'): string {
  return JSON.stringify({ summary, findings })
}

function gate(RESULT: string) {
  return runScript(
    'scripts/ai-review-report.sh',
    [],
    { PATH: `${bin}:${process.env.PATH}`, RUN_URL: 'https://example.test/run/1', RESULT },
    work,
  )
}

function output(name: string): string {
  return readFileSync(join(work, 'ai-review', name), 'utf8')
}

function counts(): unknown {
  return JSON.parse(output('result.json'))
}

const p2 = (title: string): Finding => ({ severity: 'P2', path: 'src/App.tsx', line: 4, title, body: 'Minor.' })

beforeEach(() => {
  bin = tempDir('ai-review-bin-')
  work = tempDir('ai-review-work-')
  fakeCommand(bin, 'gh')
})

describe('scripts/ai-review-report.sh', () => {
  it('passes with only P2 findings and records the counts, the summary and the findings', () => {
    const findings = [p2('Name'), p2('Comment')]
    const run = gate(result(findings))
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(counts()).toEqual({ p0: 0, p1: 0, p2: 2 })
    expect(JSON.parse(output('findings.json'))).toEqual(findings)
    expect(output('comment.md').startsWith(marker)).toBe(true)
    expect(output('comment.md')).toContain('AI-REVIEW: P0=0 P1=0 P2=2')
    expect(output('comment.md')).toContain('Looks fine overall.')
    expect(output('comment.md')).not.toContain('- **P2**')
    expect(calls(bin, 'gh')).toEqual([])
  })

  it('fails on a P1 and lists it in the log, with model text kept inert', () => {
    const run = gate(
      result([
        { severity: 'P1', path: 'scripts/x.js', line: 3, title: 'XSS\nfrom the URL', body: 'innerHTML from the URL.\nEscape it.' },
        p2('Rename'),
      ]),
    )
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('review required before merge')
    // scripts/ai-review-submit.sh lists the findings, each once; the summary carries none of them.
    expect(output('comment.md')).not.toContain('scripts/x.js:3')
    expect(output('comment.md')).not.toContain('XSS')
    expect(counts()).toEqual({ p0: 0, p1: 1, p2: 1 })

    const lines = run.stdout.split('\n')
    const listed = lines.indexOf('AI review P1 scripts/x.js:3 - XSS from the URL')
    expect(listed).toBeGreaterThan(0)
    expect(lines.slice(listed + 1, listed + 3)).toEqual(['  | innerHTML from the URL.', '  | Escape it.'])
    expect(run.stdout).not.toContain('Rename')
    const start = lines.findIndex((line) => line.startsWith('::stop-commands::'))
    const token = lines[start]?.slice('::stop-commands::'.length) ?? ''
    expect(token).not.toBe('')
    expect(start).toBeLessThan(listed)
    const end = lines.indexOf(`::${token}::`)
    expect(end).toBeGreaterThan(listed + 2)
    expect(end).toBeLessThan(lines.findIndex((line) => line.startsWith('::error::')))
  })

  it('fails on a P0 and names a finding on no file line PR', () => {
    const run = gate(result([{ severity: 'P0', path: '', line: 0, title: 'Secret in the body', body: 'A key.' }]))
    expect(run.status).toBe(1)
    expect(counts()).toEqual({ p0: 1, p1: 0, p2: 0 })
    expect(run.stdout.split('\n')).toContain('AI review P0 PR - Secret in the body')
  })

  it('fails closed without a review summary and leaves no stale output', () => {
    mkdirSync(join(work, 'ai-review'))
    for (const name of ['comment.md', 'result.json', 'findings.json']) writeFileSync(join(work, 'ai-review', name), '{}')
    const run = gate('')
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('no review summary')
    for (const name of ['comment.md', 'result.json', 'findings.json'])
      expect(existsSync(join(work, 'ai-review', name)), name).toBe(false)
  })

  it.each([
    ['findings that are not a list', JSON.stringify({ summary: 's', findings: 'x' })],
    ['an unknown severity', result([{ severity: 'P5', path: 'a', line: 1, title: 't', body: 'd' }])],
    ['text that is not JSON', 'not json'],
    ['a missing summary', JSON.stringify({ findings: [] })],
    ['a null summary', JSON.stringify({ summary: null, findings: [] })],
    ['an empty summary', result([], '')],
    ['a finding without a title', result([{ severity: 'P2', path: 'a', line: 1, body: 'd' }])],
    ['a finding without a body', result([{ severity: 'P2', path: 'a', line: 1, title: 't' }])],
    ['a finding without a path', result([{ severity: 'P2', line: 1, title: 't', body: 'd' }])],
    ['a finding without a line', result([{ severity: 'P2', path: 'a', title: 't', body: 'd' }])],
    ['a negative line', result([{ severity: 'P2', path: 'a', line: -1, title: 't', body: 'd' }])],
    ['a fractional line', result([{ severity: 'P2', path: 'a', line: 1.5, title: 't', body: 'd' }])],
  ])('fails closed on %s', (_, value) => {
    const run = gate(value)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('no review summary')
    expect(existsSync(join(work, 'ai-review', 'result.json'))).toBe(false)
    expect(existsSync(join(work, 'ai-review', 'findings.json'))).toBe(false)
  })

  it('treats the findings as data', () => {
    const touched = join(work, 'touched')
    const run = gate(result([p2(`\`touch ${touched}\` $(touch ${touched})`)], `$(touch ${touched})`))
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(existsSync(touched)).toBe(false)
    expect(output('comment.md')).toContain(`$(touch ${touched})`)
  })
})
