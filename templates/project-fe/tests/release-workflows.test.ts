import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { repoRoot } from './support.ts'

interface Step {
  uses?: string
  run?: string
  if?: string
  with?: Record<string, string | number>
  env?: Record<string, string>
}

interface Job {
  needs?: string | string[]
  if?: string
  environment?: string
  permissions?: Record<string, string>
  steps: Step[]
}

interface Workflow {
  on: Record<string, { branches?: string[]; types?: string[]; tags?: string[] } | null>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const notifyTelegram = 'OlegShevtsov1/1_mvp_infra/.github/actions/notify-telegram@env/dev'

function load(file: string) {
  const text = readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8')
  return { text, workflow: parse(text) as Workflow }
}

function indexOf(steps: Step[], match: (step: Step) => boolean): number {
  const index = steps.findIndex(match)
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

const runs = (step: Step, script: string) => step.run?.includes(script) ?? false

function expectNoExpressionsInRun(workflow: Workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) expect(step.run ?? '').not.toContain('${{')
  }
}

describe('changelog-check workflow', () => {
  const { workflow } = load('changelog-check.yml')

  it('runs on pull requests into develop and main, also when labels change', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request'])
    const trigger = workflow.on.pull_request
    expect(trigger?.branches).toEqual(['develop', 'main'])
    expect(trigger?.types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'labeled', 'unlabeled']))
  })

  it('checks the full history and passes the PR data only through env', () => {
    const jobs = Object.values(workflow.jobs)
    expect(jobs).toHaveLength(1)
    const steps = jobs[0].steps
    expect(steps[0].uses).toMatch(/^actions\/checkout@/)
    expect(steps[0].with?.['fetch-depth']).toBe(0)
    const check = steps[indexOf(steps, (step) => runs(step, 'scripts/changelog-check.sh'))]
    expect(Object.keys(check.env ?? {})).toEqual(
      expect.arrayContaining(['BASE_REF', 'HEAD_REF', 'BASE_SHA', 'HEAD_SHA', 'LABELS', 'PR_BODY']),
    )
    expectNoExpressionsInRun(workflow)
  })
})

describe('release workflow', () => {
  const { text, workflow } = load('release.yml')

  it('runs only on pushed v* tags', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } })
  })

  it('checks the tag, then creates a draft Release from the CHANGELOG section, metrics last', () => {
    const job = workflow.jobs.release
    expect(job.permissions).toMatchObject({ contents: 'write' })
    const steps = job.steps
    expect(steps[0].uses).toMatch(/^actions\/checkout@/)
    expect(steps[0].with?.['fetch-depth']).toBe(0)
    const refetch = indexOf(steps, (step) => runs(step, 'git fetch') && runs(step, 'refs/tags'))
    const check = indexOf(steps, (step) => runs(step, 'scripts/release-check.sh'))
    const notes = indexOf(steps, (step) => runs(step, 'scripts/release-notes.sh'))
    const create = indexOf(steps, (step) => runs(step, 'gh release create'))
    expect(refetch).toBeLessThan(check)
    expect(check).toBeLessThan(notes)
    expect(notes).toBeLessThan(create)
    for (const flag of ['--draft', '--verify-tag', '--notes-file']) expect(steps[create].run).toContain(flag)
    expect(steps.at(-1)?.run).toContain('bin/sdlc-metrics')
  })

  it('reports success and failure to the prod alerts topic', () => {
    const notify = workflow.jobs.notify
    expect(([] as string[]).concat(notify.needs ?? [])).toContain('release')
    expect(notify.if).toMatch(/^always\(\)/)
    expect(notify.environment).toBe('prod')
    const telegram = notify.steps.find((step) => step.uses === notifyTelegram)
    expect(telegram?.with?.topic).toBe('PROD_ALERTS')
  })

  it('uses no LLM and never writes to a branch', () => {
    expect(text).not.toMatch(/claude|anthropic/i)
    expect(text).not.toMatch(/git push/)
    expectNoExpressionsInRun(workflow)
  })
})

describe('README', () => {
  it('documents releases and hotfixes', () => {
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toMatch(/^## Releases and hotfixes$/m)
  })
})
