import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { repoRoot } from './support.ts'

interface Step {
  id?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, string>
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
  'run-name'?: string
  on: { workflow_dispatch?: { inputs: Record<string, { required?: boolean; type?: string; options?: string[] }> } }
  concurrency: unknown
  jobs: Record<string, Job>
}

const vpnUp = 'OlegShevtsov1/1_mvp_infra/.github/actions/vpn-up@env/dev'
const vpnDown = 'OlegShevtsov1/1_mvp_infra/.github/actions/vpn-down@env/dev'
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

function needs(job: Job): string[] {
  return ([] as string[]).concat(job.needs ?? [])
}

// Shared by Kamal Deploy and Kamal Manage: both act on prod and follow the same guard order.
function expectProdShape(text: string, workflow: Workflow, mainJob: string, guardMode: string) {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.concurrency).toEqual({ group: 'kamal-prod', 'cancel-in-progress': false })

  const guard = workflow.jobs.guard
  expect(guard.environment).toBeUndefined()
  expect(guard.steps[0].uses).toMatch(/^actions\/checkout@/)
  expect(guard.steps[1].run).toContain(`deploy/prod_guard.sh ${guardMode}`)

  const preflight = workflow.jobs.preflight
  expect(preflight.environment).toBe('prod')
  expect(needs(preflight)).toContain('guard')
  expect(preflight.steps.some((step) => runs(step, 'deploy/prod_preflight.sh'))).toBe(true)

  expect(workflow.jobs['vpn-up-check'].steps.map((step) => step.uses)).toEqual(
    expect.arrayContaining([vpnUp, vpnDown]),
  )

  const main = workflow.jobs[mainJob]
  expect(main.environment).toBe('prod')
  expect(needs(main)).toEqual(expect.arrayContaining(['guard', 'preflight', 'vpn-up-check']))
  expect(main.steps.at(-1)).toMatchObject({ uses: vpnDown, if: 'always()' })

  const notify = workflow.jobs.notify
  expect(notify.if).toMatch(/^always\(\)/)
  const telegram = notify.steps.find((step) => step.uses === notifyTelegram)
  expect(telegram?.with?.topic).toBe('PROD_ALERTS')

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      expect(step.uses ?? '').not.toMatch(/^docker\/(build-push|setup-buildx)-action@/)
      expect(step.run ?? '').not.toMatch(/docker build|buildx/)
      expect(step.run ?? '').not.toContain('${{')
    }
  }
  expect(text).not.toMatch(/kamal remove|kamal proxy/)
}

describe('Kamal Deploy workflow', () => {
  const { text, workflow } = load('kamal-deploy.yml')

  it('is dispatched with environment, version and confirm', () => {
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {}
    expect(Object.keys(inputs)).toEqual(['environment', 'version', 'confirm'])
    expect(inputs.environment).toMatchObject({ type: 'choice', options: ['prod'] })
    for (const input of Object.values(inputs)) expect(input.required).toBe(true)
  })

  it('guards first, never builds, and reaches prod only over the VPN', () => {
    expectProdShape(text, workflow, 'deploy', 'deploy')
  })

  it('only deploys a commit on main', () => {
    const steps = workflow.jobs.guard.steps
    expect(indexOf(steps, (step) => runs(step, 'deploy/main_commit_check.sh'))).toBeGreaterThan(
      indexOf(steps, (step) => runs(step, 'deploy/prod_guard.sh')),
    )
  })

  it('promotes the dev image before taking the VPN lock, then deploys', () => {
    const steps = workflow.jobs.deploy.steps
    const promote = indexOf(steps, (step) => runs(step, 'deploy/promote.sh'))
    const up = indexOf(steps, (step) => step.uses === vpnUp)
    const deploy = indexOf(steps, (step) => runs(step, 'deploy/deploy.sh prod'))
    expect(promote).toBeLessThan(up)
    expect(up).toBeLessThan(deploy)
  })

  it('resolves the release tag between the input check and the main check', () => {
    const steps = workflow.jobs.guard.steps
    const tag = indexOf(steps, (step) => runs(step, 'deploy/tag_check.sh'))
    expect(tag).toBeGreaterThan(indexOf(steps, (step) => runs(step, 'deploy/prod_guard.sh')))
    expect(tag).toBeLessThan(indexOf(steps, (step) => runs(step, 'deploy/main_commit_check.sh')))
  })

  it('deploys the release tag, which deploy.sh checks again, with the backend read token', () => {
    const step = workflow.jobs.deploy.steps.find((candidate) => runs(candidate, 'deploy/deploy.sh prod'))
    expect(step?.run).toContain('deploy/deploy.sh prod "$TAG"')
    expect(Object.keys(step?.env ?? {})).toEqual(expect.arrayContaining(['GH_TOKEN', 'GH_REPO', 'BE_REPO_TOKEN']))
  })

  it('names the release secrets in its preflight', () => {
    const step = workflow.jobs.preflight.steps.find((candidate) => runs(candidate, 'deploy/prod_preflight.sh'))
    for (const name of ['BE_REPO_READ_TOKEN', 'GLITCHTIP_API_URL', 'GLITCHTIP_API_TOKEN']) {
      expect(step?.run).toContain(name)
      expect(Object.keys(step?.env ?? {})).toContain(name)
    }
  })

  it('watches prod for 10 minutes after a successful deploy and reports to the prod alerts topic', () => {
    const watch = workflow.jobs['release-watch']
    expect(needs(watch)).toEqual(expect.arrayContaining(['guard', 'deploy']))
    expect(watch.if).toBeUndefined()
    expect(watch.environment).toBe('prod')
    expect(watch.permissions).toMatchObject({ 'id-token': 'write' })
    const steps = watch.steps
    const up = indexOf(steps, (step) => step.uses === vpnUp)
    const run = indexOf(steps, (step) => runs(step, 'deploy/release_watch.sh'))
    const down = indexOf(steps, (step) => step.uses === vpnDown)
    expect(up).toBeLessThan(run)
    expect(run).toBeLessThan(down)
    expect(steps[down].if).toBe('always()')
    expect(Object.keys(steps[run].env ?? {})).toEqual(
      expect.arrayContaining(['TAG', 'GLITCHTIP_API_URL', 'GLITCHTIP_API_TOKEN']),
    )
    const telegram = steps.find((step) => step.uses === notifyTelegram)
    expect(telegram?.if).toBe('always()')
    expect(telegram?.with?.topic).toBe('PROD_ALERTS')
    for (const step of steps) expect(step.run ?? '').not.toMatch(/rollback/)
  })
})

describe('Kamal Manage workflow', () => {
  const { text, workflow } = load('kamal-manage.yml')

  it('is dispatched with an action and optional version and confirm', () => {
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {}
    expect(Object.keys(inputs)).toEqual(['action', 'version', 'confirm'])
    expect(inputs.action).toMatchObject({
      type: 'choice',
      options: ['status', 'logs', 'restart', 'rollback', 'remove'],
    })
    expect(inputs.version.required).toBe(false)
    expect(inputs.confirm.required).toBe(false)
  })

  it('guards first, never builds, and reaches prod only over the VPN', () => {
    expectProdShape(text, workflow, 'manage', 'manage')
  })

  it('runs rollback and the other actions through the scripts inside the VPN window', () => {
    const steps = workflow.jobs.manage.steps
    const up = indexOf(steps, (step) => step.uses === vpnUp)
    const action = indexOf(steps, (step) => runs(step, 'deploy/rollback.sh prod') && runs(step, 'deploy/manage.sh'))
    expect(up).toBeLessThan(action)
  })

  it('passes the typed rollback confirmation and the resolved version to the rollback script', () => {
    const step = workflow.jobs.manage.steps.find((candidate) => runs(candidate, 'deploy/rollback.sh prod'))
    expect(Object.keys(step?.env ?? {})).toEqual(expect.arrayContaining(['ROLLBACK_CONFIRM', 'VERSION', 'SHA']))
  })

  it('names each run after its action, so prod rollbacks can be counted', () => {
    expect(workflow['run-name']).toContain('inputs.action')
  })
})
