import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, runScript, tempDir } from './support.ts'

interface Finding {
  severity: string
  file: string
  line?: number
  title: string
  detail: string
}

const marker = '<!-- ai-review -->'
let bin: string
let work: string

function fakeGh(tail = '') {
  fakeCommand(
    bin,
    'gh',
    `case "$*" in
  *--paginate*) if [ -f "${bin}/comments.json" ]; then cat "${bin}/comments.json"; else echo '[]'; fi ;;
  *) cat > "${bin}/gh.input" ;;
esac
${tail}`,
  )
}

function result(findings: Finding[] | unknown, summary = 'Looks fine overall.'): string {
  return JSON.stringify({ summary, findings })
}

function report(RESULT: string, env: Record<string, string> = {}) {
  return runScript(
    'scripts/ai-review-report.sh',
    [],
    {
      PATH: `${bin}:${process.env.PATH}`,
      REPO: 'owner/repo',
      PR_NUMBER: '7',
      RUN_URL: 'https://example.test/run/1',
      RESULT,
      ...env,
    },
    work,
  )
}

function body(): string {
  const input = JSON.parse(readFileSync(join(bin, 'gh.input'), 'utf8')) as { body: string }
  return input.body
}

function counts(): unknown {
  return JSON.parse(readFileSync(join(work, 'ai-review', 'result.json'), 'utf8'))
}

const p2 = (title: string): Finding => ({ severity: 'P2', file: 'src/App.tsx', line: 4, title, detail: 'Minor.' })

beforeEach(() => {
  bin = tempDir('ai-review-bin-')
  work = tempDir('ai-review-work-')
  fakeGh()
})

describe('scripts/ai-review-report.sh', () => {
  it('passes with only P2 findings and records the counts', () => {
    const run = report(result([p2('Name'), p2('Comment')]))
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(counts()).toEqual({ p0: 0, p1: 0, p2: 2 })
    expect(calls(bin, 'gh')).toContainEqual(expect.stringContaining('POST repos/owner/repo/issues/7/comments'))
    expect(body().startsWith(marker)).toBe(true)
    expect(body()).toContain('AI-REVIEW: P0=0 P1=0 P2=2')
  })

  it('fails on a P1 and names its file and line', () => {
    const run = report(
      result([{ severity: 'P1', file: 'scripts/x.js', line: 3, title: 'XSS', detail: 'innerHTML from the URL.' }]),
    )
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('review required before merge')
    expect(body()).toContain('scripts/x.js:3')
    expect(counts()).toEqual({ p0: 0, p1: 1, p2: 0 })
  })

  it('fails on a P0', () => {
    const run = report(result([{ severity: 'P0', file: 'src/config.ts', title: 'Secret', detail: 'A key.' }]))
    expect(run.status).toBe(1)
    expect(counts()).toEqual({ p0: 1, p1: 0, p2: 0 })
  })

  it('updates its earlier comment instead of adding one', () => {
    writeFileSync(
      join(bin, 'comments.json'),
      JSON.stringify([
        { id: 41, user: { login: 'someone' }, body: `${marker}\nquoted` },
        { id: 42, user: { login: 'github-actions[bot]' }, body: `${marker}\n### AI review` },
        { id: 43, user: { login: 'github-actions[bot]' }, body: 'Another bot comment' },
      ]),
    )
    const run = report(result([]))
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const gh = calls(bin, 'gh')
    expect(gh).toContainEqual(expect.stringContaining('PATCH repos/owner/repo/issues/comments/42'))
    expect(gh.some((line) => line.includes('POST'))).toBe(false)
  })

  it('fails closed without a review summary', () => {
    const run = report('')
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('no review summary')
    expect(existsSync(join(work, 'ai-review', 'result.json'))).toBe(false)
    expect(body()).toContain('AI-REVIEW: no summary')
  })

  it.each([
    ['findings that are not a list', JSON.stringify({ summary: 's', findings: 'x' })],
    ['an unknown severity', result([{ severity: 'P5', file: 'a', title: 't', detail: 'd' }])],
    ['text that is not JSON', 'not json'],
    ['a missing summary', JSON.stringify({ findings: [] })],
    ['a null summary', JSON.stringify({ summary: null, findings: [] })],
    ['an empty summary', result([], '')],
    ['a finding without a title', JSON.stringify({ summary: 's', findings: [{ severity: 'P2', file: 'a', detail: 'd' }] })],
    ['a finding without a detail', JSON.stringify({ summary: 's', findings: [{ severity: 'P2', file: 'a', title: 't' }] })],
  ])('fails closed on %s', (_, value) => {
    const run = report(value)
    expect(run.status).toBe(1)
    expect(existsSync(join(work, 'ai-review', 'result.json'))).toBe(false)
    expect(body()).toContain('AI-REVIEW: no summary')
  })

  it('fails when the review cannot be posted', () => {
    fakeGh('exit 1')
    const run = report(result([]))
    expect(run.status).not.toBe(0)
    expect(run.stdout).toContain('could not post the review comment')
  })

  it('treats the findings as data', () => {
    const touched = join(work, 'touched')
    const run = report(result([p2(`\`touch ${touched}\` $(touch ${touched})`)], `$(touch ${touched})`))
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(existsSync(touched)).toBe(false)
    expect(body()).toContain(`$(touch ${touched})`)
  })

  it.each([
    ['PR_NUMBER', '7; rm -rf /'],
    ['REPO', 'owner/repo/../x'],
  ])('rejects a malformed %s', (name, value) => {
    const run = report(result([]), { [name]: value })
    expect(run.status).toBe(2)
    expect(calls(bin, 'gh')).toEqual([])
  })
})
