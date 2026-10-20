import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { projectEnv, repoRoot } from './support.ts'

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string | number>
}

interface Job {
  needs?: string | string[]
  if?: string
  environment?: string
  permissions?: Record<string, string>
  steps: Step[]
}

interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

interface Profile {
  stack: { test_command: string; lint_command: string; build_command: string }
  repo: { merge_strategy: string }
  deploy: { command: string; health_url: string; wait_seconds: number; rollback_command: string }
  monitoring: { provider: string }
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

function workflow(name: string): Workflow {
  return parse(read(join('.github', 'workflows', name))) as Workflow
}

function runs(flow: Workflow): string[] {
  return Object.values(flow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ''))
}

/** The text under a `## <title>` heading, up to the next `## ` heading. */
function section(markdown: string, title: string): string {
  const start = markdown.indexOf(`\n## ${title}\n`)
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0)
  const rest = markdown.slice(start + 1)
  const end = rest.indexOf('\n## ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  expect(match).not.toBeNull()
  return parse(match![1]) as Record<string, unknown>
}

/** The commands the Front CI job runs as checks: tool downloads and `npm ci` excluded. */
function ciCheckCommands(): string[] {
  return workflow('front-ci.yml')
    .jobs.ci.steps.flatMap((step) => (step.run ?? '').split('\n'))
    .map((line) => line.trim())
    .filter((line) => line && line !== 'npm ci' && !/^(curl|echo|tar) /.test(line))
    .map((line) => line.replace(/^\.\//, ''))
}

const zone = projectEnv().PROJECT_ZONE

describe('factory profile', () => {
  const profile = parse(read('.archon/factory-profile.yaml')) as Profile

  it('deploys by waiting for Dev Deploy and checks the dev app', () => {
    expect(profile.deploy).toEqual({
      command: 'bin/wait-dev-deploy',
      health_url: `https://app.dev.${zone}/health`,
      wait_seconds: 600,
      rollback_command: 'bin/dev-rollback',
    })
    expect(profile.monitoring.provider).toBe('none')
  })

  it('uses the CI commands and squash merges', () => {
    expect(profile.stack).toMatchObject({
      test_command: 'npm test',
      lint_command: 'npm run lint',
      build_command: 'npm run build',
    })
    expect(profile.repo.merge_strategy).toBe('squash')
  })

  it.each(['bin/wait-dev-deploy', 'bin/dev-rollback'])('%s is executable', (path) => {
    expect(statSync(join(repoRoot, path)).mode & 0o111).not.toBe(0)
  })
})

describe('Claude setup', () => {
  const claude = read('CLAUDE.md')

  it('keeps CLAUDE.md short and in English', () => {
    expect(claude.split('\n').length).toBeLessThanOrEqual(200)
    expect(claude).not.toMatch(/[Ѐ-ӿ]/)
  })

  it('lists exactly the commands Front CI runs', () => {
    const commands = section(claude, 'Commands')
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]))
    expect(commands).toEqual(ciCheckCommands())
  })

  it.skipIf(!existsSync(join(repoRoot, '.claude', 'sdlc.local.md')))(
    'sets sdlc.local.md commands to Front CI commands',
    () => {
      const settings = frontmatter(read('.claude/sdlc.local.md'))
      const ci = ciCheckCommands()
      for (const key of ['cmd_test_unit', 'cmd_lint', 'cmd_vet']) {
        const command = settings[key]
        if (command) expect(ci, key).toContain(command)
      }
    },
  )

  it('keeps local settings out of git', () => {
    expect(read('.gitignore').split('\n')).toContain('.claude/*.local.md')
  })

  it('enables the SDLC plugins and denies history rewrites', () => {
    const settings = JSON.parse(read('.claude/settings.json')) as {
      enabledPlugins: Record<string, boolean>
      permissions: { deny: string[] }
    }
    expect(settings.enabledPlugins).toMatchObject({ 'sdlc@mvp': true, 'mvp-sdlc@mvp': true })
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(git push --force*)', 'Bash(git reset --hard*)']),
    )
  })

  it('has the pull request template', () => {
    expect(read('.github/pull_request_template.md')).toContain('Definition of Done')
  })
})

describe('tdd-check workflow', () => {
  const flow = workflow('tdd-check.yml')
  const steps = flow.jobs['tdd-check'].steps

  it('checks every pull request with the full history', () => {
    expect(flow.on).toHaveProperty('pull_request')
    expect(flow.jobs['tdd-check'].permissions ?? flow.permissions).toEqual({
      contents: 'read',
      statuses: 'write',
    })
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['fetch-depth']).toBe(0)
    expect(steps.some((step) => step.run === 'bash scripts/tdd-check.sh')).toBe(true)
  })

  it('keeps expressions out of run scripts', () => {
    for (const run of runs(flow)) expect(run).not.toContain('${{')
  })
})

describe('main-guard workflow', () => {
  const flow = workflow('main-guard.yml')

  it('checks every push to main, and a given sha on demand', () => {
    expect(flow.on.push).toEqual({ branches: ['main'] })
    expect(flow.on.workflow_dispatch).toMatchObject({ inputs: { sha: { type: 'string', required: false } } })
  })

  it('runs the guard without environment secrets', () => {
    const guard = flow.jobs.guard
    expect(guard.environment).toBeUndefined()
    expect(guard.steps.some((step) => step.run === 'bash scripts/main-guard.sh')).toBe(true)
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
  })

  it('keeps expressions out of run scripts', () => {
    for (const run of runs(flow)) expect(run).not.toContain('${{')
  })
})

describe('Front CI', () => {
  it('checks the built bundle for environment values after the build', () => {
    const steps = workflow('front-ci.yml').jobs.ci.steps
    const build = steps.findIndex((step) => step.run === 'npm run build')
    const bundle = steps.findIndex((step) => step.run === 'bash scripts/check-bundle-config.sh src dist')
    expect(build).toBeGreaterThanOrEqual(0)
    expect(bundle).toBeGreaterThan(build)
  })
})

describe('README', () => {
  it('starts or boots the app by hand only with an explicit version', () => {
    const lines = read('README.md')
      .split('\n')
      .filter((line) => /kamal app (start|boot)/.test(line))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toContain('--version')
  })
})

describe('architecture map and glossary', () => {
  const map = read('docs/architecture-map.md')

  // A new project starts from the template's skeleton: every field is UNKNOWN until the first
  // /sdlc-map-architecture fills it with a real commit, date and cited sections.
  it('records the commit it reflects, or UNKNOWN before the first map', () => {
    const meta = frontmatter(map)
    expect(Object.keys(meta)).toEqual(expect.arrayContaining(['status', 'mode', 'updated_at', 'reflects_commit']))
    expect(String(meta.reflects_commit)).toMatch(/^([0-9a-f]{7,40}|UNKNOWN)$/)
    expect(String(meta.updated_at)).toMatch(/^(\d{4}-\d\d-\d\d|UNKNOWN)$/)
  })

  it('has a frontend foundation section', () => {
    expect(section(map, 'Frontend / UI foundation').length).toBeGreaterThan(0)
  })

  it('cites only lines that exist', () => {
    const anchors = [...map.matchAll(/`([A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?`/g)]
    for (const [, path, from, to] of anchors) {
      expect(existsSync(join(repoRoot, path)), path).toBe(true)
      const lines = read(path).split('\n').length
      expect(lines, `${path}:${from}`).toBeGreaterThanOrEqual(Number(to ?? from))
    }
  })

  it('has a glossary', () => {
    expect(read('CONTEXT.md')).toContain('\n## Glossary\n')
  })
})
