import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { commit, fakeCommand, git, gitRepo, repoRoot, runScript, tempDir } from './support.ts'

let repo: string
let bin: string
let summary: string

const pulls: Record<number, { created_at: string; merged_at: string }> = {
  2: { created_at: '2026-10-10T00:00:00Z', merged_at: '2026-10-10T10:00:00Z' },
  3: { created_at: '2026-10-11T00:00:00Z', merged_at: '2026-10-11T20:00:00Z' },
}

function fakeGh() {
  const cases = Object.entries(pulls)
    .map(([number, pull]) => `  *repos/owner/repo/pulls/${number}) echo '${JSON.stringify(pull)}' ;;`)
    .join('\n')
  const runs = {
    workflow_runs: [{ display_title: 'Kamal Manage rollback' }, { display_title: 'Kamal Manage status' }],
  }
  fakeCommand(
    bin,
    'gh',
    `case "$*" in
${cases}
  *repos/owner/repo/actions/workflows/kamal-manage.yml/runs*) echo '${JSON.stringify(runs)}' ;;
  *) exit 1 ;;
esac`,
  )
}

function metrics(...args: string[]) {
  return runScript(
    'bin/sdlc-metrics',
    args,
    { PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'owner/repo', GITHUB_STEP_SUMMARY: summary },
    repo,
  )
}

function field(line: string, name: string): string | undefined {
  return line.match(new RegExp(`(?:^| )${name}=(\\S+)`))?.[1]
}

function factoryRun(dir: string, run: string, report: object, findings: object[]) {
  mkdirSync(join(dir, run, 'review'), { recursive: true })
  writeFileSync(join(dir, run, 'report.json'), JSON.stringify(report))
  writeFileSync(join(dir, run, 'review', 'findings.json'), JSON.stringify(findings))
}

beforeEach(() => {
  repo = gitRepo('sdlc-metrics-')
  bin = tempDir('sdlc-metrics-bin-')
  summary = join(bin, 'summary.md')
  fakeGh()
  mkdirSync(join(repo, 'docs', 'features', 'old'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'features', 'old', 'prd.md'), '---\nstatus: Draft\n---\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '--date=2026-01-01T00:00:00Z', '-m', 'docs: old draft')
  commit(repo, 'APP-1: First (#1)\n\nType: feat', { 'a.txt': '1' })
  git(repo, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
  commit(repo, 'APP-2: Second (#2)\n\nType: fix', { 'a.txt': '2' })
  commit(repo, 'APP-3: Third (#3)\n\nType: feat', { 'a.txt': '3' })
  git(repo, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0')
})

describe('bin/sdlc-metrics', () => {
  it('prints one team metrics line for the release and appends it to the step summary', () => {
    const result = metrics('v0.2.0')
    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line).toMatch(/^sdlc-metrics repo=owner\/repo release=v0\.2\.0 date=\d{4}-\d{2}-\d{2} previous=v0\.1\.0 /)
    expect(field(line, 'prs')).toBe('2')
    expect(field(line, 'lead_time_days')).toMatch(/^\d+\.\d$/)
    expect(field(line, 'cycle_time_median_hours')).toBe('15.0')
    expect(field(line, 'rollbacks_prod')).toBe('1')
    expect(field(line, 'stale_drafts')).toBe('1')
    expect(field(line, 'delivered_false')).toBe('n/a')
    expect(field(line, 'review_p0_p1_p2')).toBe('n/a')
    expect(readFileSync(summary, 'utf8')).toContain(line)
  })

  it('counts every squash commit for the first release', () => {
    const result = metrics('v0.1.0')
    expect(result.status, result.stderr).toBe(0)
    expect(field(result.stdout, 'previous')).toBe('none')
    expect(field(result.stdout, 'prs')).toBe('1')
  })

  it('reports n/a and still succeeds when GitHub cannot be read', () => {
    fakeCommand(bin, 'gh', 'exit 1')
    const result = metrics('v0.2.0')
    expect(result.status, result.stderr).toBe(0)
    expect(field(result.stdout, 'cycle_time_median_hours')).toBe('n/a')
    expect(field(result.stdout, 'rollbacks_prod')).toBe('n/a')
  })

  it('reads delivery and review findings of the factory runs of the PRs in the release', () => {
    const runs = tempDir('factory-runs-')
    factoryRun(runs, 'run-a', { delivered: false, pr_url: 'https://github.com/owner/repo/pull/2' }, [
      { severity: 'Important' },
    ])
    factoryRun(runs, 'run-b', { delivered: true, pr_url: 'https://github.com/owner/repo/pull/3' }, [
      { severity: 'Suggestion' },
    ])
    factoryRun(runs, 'run-c', { delivered: false, pr_url: 'https://github.com/owner/repo/pull/99' }, [
      { severity: 'Critical' },
    ])
    const result = metrics('--factory-runs', runs, 'v0.2.0')
    expect(result.status, result.stderr).toBe(0)
    expect(field(result.stdout, 'delivered_false')).toBe('1/2')
    expect(field(result.stdout, 'review_p0_p1_p2')).toBe('0/1/1')
  })

  it('counts escaped defects only once their 7-day window has closed', () => {
    const result = metrics('--escaped', 'v0.2.0')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/window closes on \d{4}-\d{2}-\d{2}/)
  })

  it('counts the prod issues first seen within 7 days of the tag, resolved or not, once each', () => {
    const tagged = spawnSync('git', ['tag', '-a', 'v0.3.0', '-m', 'v0.3.0'], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-09-01T00:00:00Z' },
    })
    expect(tagged.status, tagged.stderr.toString()).toBe(0)
    mkdirSync(join(repo, 'config'))
    copyFileSync(join(repoRoot, 'config', 'project.env'), join(repo, 'config', 'project.env'))
    const unresolved = [
      { id: '1', title: 'before the tag', firstSeen: '2026-08-31T23:59:59Z' },
      { id: '2', title: 'in both lists', firstSeen: '2026-09-02T10:00:00.123456Z' },
    ]
    const resolved = [
      { id: '2', title: 'in both lists', firstSeen: '2026-09-02T10:00:00.123456Z' },
      { id: '3', title: 'resolved later', firstSeen: '2026-09-07T23:59:59+00:00' },
      { id: '4', title: 'after the window', firstSeen: '2026-09-08T00:00:00Z' },
      { id: '5', title: 'never seen', firstSeen: null },
    ]
    fakeCommand(
      bin,
      'curl',
      `if grep -q 'query=is%3Aresolved'; then echo '${JSON.stringify(resolved)}'; else echo '${JSON.stringify(unresolved)}'; fi`,
    )
    const result = runScript(
      'bin/sdlc-metrics',
      ['--escaped', 'v0.3.0'],
      {
        PATH: `${bin}:${process.env.PATH}`,
        GLITCHTIP_API_URL: 'https://glitchtip.invalid',
        GLITCHTIP_API_TOKEN: 'TOKEN-SENTINEL',
      },
      repo,
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('sdlc-metrics-escaped release=v0.3.0 escaped_defects=2 window=7d\n')
  })

  it('rejects usage errors', () => {
    expect(metrics().status).toBe(2)
    expect(metrics('v9.9.9').status).toBe(2)
    expect(existsSync(summary)).toBe(false)
  })
})
