import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { repoRoot } from './support.ts'

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

interface Job {
  name?: string
  needs?: string | string[]
  if?: string
  environment?: string
  steps: Step[]
}

interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

interface Profile {
  repo: { base_branch: string; merge_strategy: string }
}

const expressionOpener = '$' + '{{'

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

function workflow(name: string): Workflow {
  return parse(read(join('.github', 'workflows', name))) as Workflow
}

function runs(flow: Workflow): string[] {
  return Object.values(flow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ''))
}

describe('develop-guard workflow', () => {
  const flow = workflow('develop-guard.yml')

  it('checks every push to develop, and a given sha on demand', () => {
    expect(flow.on.push).toEqual({ branches: ['develop'] })
    expect(flow.on.workflow_dispatch).toMatchObject({ inputs: { sha: { type: 'string', required: false } } })
  })

  it('runs the main-guard script for develop without environment secrets', () => {
    const guard = flow.jobs.guard
    expect(guard.environment).toBeUndefined()
    const step = guard.steps.find((candidate) => candidate.run === 'bash scripts/main-guard.sh')
    expect(step?.env?.BRANCH).toBe('develop')
  })

  it('alerts the dev alerts topic when the guard fails', () => {
    const alert = flow.jobs.alert
    expect(alert.needs).toBe('guard')
    expect(alert.if).toBe('failure()')
    expect(alert.environment).toBe('dev')
    const notify = alert.steps.find(
      (step) => step.uses === 'OlegShevtsov1/1_mvp_infra/.github/actions/notify-telegram@env/dev',
    )
    expect(notify?.with?.topic).toBe('DEV_ALERTS')
    expect(Object.keys(notify?.env ?? {}).sort()).toEqual([
      'TELEGRAM_DEV_ALERTS_BOT_TOKEN',
      'TELEGRAM_DEV_ALERTS_CHAT_ID',
      'TELEGRAM_DEV_ALERTS_THREAD_ID',
    ])
    const compose = alert.steps.find((step) => step.run?.includes('develop-guard'))
    expect(compose?.run).toContain('on develop')
  })

  it('keeps expressions out of run scripts', () => {
    for (const run of runs(flow)) expect(run).not.toContain(expressionOpener)
  })
})

describe('pr-conventions-check workflow', () => {
  const flow = workflow('pr-conventions-check.yml')

  it('checks pull requests into develop and main, again when their text is edited', () => {
    expect(flow.on.pull_request).toEqual({
      branches: ['develop', 'main'],
      types: ['opened', 'edited', 'reopened', 'synchronize'],
    })
    expect(flow.permissions).toEqual({ contents: 'read' })
  })

  it('passes the pull request text to the script only through the environment', () => {
    const jobs = Object.values(flow.jobs)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].name).toBe('Branch name, PR title, Type line')
    const step = jobs[0].steps.find((candidate) => candidate.run === 'bash scripts/pr-conventions.sh')
    expect(Object.keys(step?.env ?? {}).sort()).toEqual([
      'BASE_REF',
      'GH_TOKEN',
      'HEAD_REF',
      'PR_BODY',
      'PR_TITLE',
      'REPO',
    ])
  })

  it('keeps expressions out of run scripts', () => {
    for (const run of runs(flow)) expect(run).not.toContain(expressionOpener)
  })
})

describe('Front CI', () => {
  it('runs on pushes to main, develop and hotfix branches, and on pull requests', () => {
    const flow = workflow('front-ci.yml')
    expect(flow.on.push).toEqual({ branches: ['main', 'develop', 'hotfix/*'] })
    expect(flow.on).toHaveProperty('pull_request')
  })
})

describe('factory profile', () => {
  it('opens and squash merges its pull requests into develop', () => {
    const profile = parse(read('.archon/factory-profile.yaml')) as Profile
    expect(profile.repo.base_branch).toBe('develop')
    expect(profile.repo.merge_strategy).toBe('squash')
  })
})

describe('pull request template', () => {
  const template = read('.github/pull_request_template.md')

  it('has exactly one Type line and names every allowed type', () => {
    expect(template.split('\n').filter((line) => line.startsWith('Type:'))).toHaveLength(1)
    for (const type of ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'ci']) expect(template).toContain(type)
  })

  it('explains the ticket key title', () => {
    expect(template).toContain('<KEY>-<')
    expect(template).toContain('PROJECT_NAME from')
  })
})
