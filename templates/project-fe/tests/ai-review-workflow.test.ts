import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { repoRoot, tempDir } from './support.ts'

interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, string | number>
  env?: Record<string, string>
}

interface Job {
  if?: string
  'runs-on'?: string
  'timeout-minutes'?: number
  steps: Step[]
}

interface Workflow {
  on: Record<string, { branches?: string[]; types?: string[] } | null>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const action = 'anthropics/claude-code-action@v1'
const enabled = "steps.switch.outputs.enabled == 'true'"

function load(file: string) {
  const text = readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8')
  return { text, workflow: parse(text) as Workflow }
}

/** The value of a `--flag "value"` or `--flag 'value'` option in claude_args. */
function option(args: string, flag: string): string {
  const match = new RegExp(`${flag} (["'])(.*?)\\1`).exec(args)
  expect(match, flag).not.toBeNull()
  return match?.[2] ?? ''
}

describe('ai-review workflow', () => {
  const { text, workflow } = load('ai-review.yml')
  const job = workflow.jobs['ai-review']
  const steps = job.steps
  const condition = job.if ?? ''

  it('runs on the decision-32 pull request events and on new comments', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request', 'issue_comment'])
    expect(workflow.on.pull_request?.types).toEqual([
      'opened',
      'reopened',
      'ready_for_review',
      'synchronize',
      'review_requested',
    ])
    expect(workflow.on.pull_request?.branches).toBeUndefined()
    expect(workflow.on.issue_comment?.types).toEqual(['created'])
  })

  it('skips factory branches, Dependabot, drafts and the release PR', () => {
    expect(condition).toContain("!startsWith(github.event.pull_request.head.ref, 'archon/task-factory-')")
    expect(condition).toContain("github.actor != 'dependabot[bot]'")
    expect(condition).toContain("github.event.pull_request.user.login != 'dependabot[bot]'")
    expect(condition).toContain('!github.event.pull_request.draft')
    expect(condition).toContain(
      "!(github.event.pull_request.head.ref == 'develop' && github.event.pull_request.base.ref == 'main')",
    )
  })

  it('re-reviews only on an "@claude review" comment by a writer on an open PR', () => {
    expect(condition).toContain('github.event.issue.pull_request')
    expect(condition).toContain("github.event.issue.state == 'open'")
    expect(condition).toContain("contains(github.event.comment.body, '@claude review')")
    expect(condition).toContain('github.event.comment.author_association')
    for (const role of ['OWNER', 'MEMBER', 'COLLABORATOR']) expect(condition).toContain(role)
  })

  it('runs on the runner chosen by vars.RUNS_ON', () => {
    expect(job['runs-on']).toBe("${{ vars.RUNS_ON || 'ubuntu-latest' }}")
    expect(job['timeout-minutes']).toBeLessThanOrEqual(15)
  })

  it('asks only for the permissions it needs', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write', issues: 'write' })
    expect(text).not.toContain('id-token')
  })

  it('decides the switch first and reaches no review step when it is off', () => {
    const [switchStep, ...rest] = steps
    expect(switchStep.id).toBe('switch')
    expect(switchStep.uses).toBeUndefined()
    expect(switchStep.env?.AI_REVIEW).toBe('${{ vars.AI_REVIEW }}')
    expect(rest.length).toBeGreaterThan(0)
    for (const step of rest) expect(step.if, step.name ?? step.uses).toContain(enabled)

    for (const value of [undefined, '', 'off', 'ON', 'on']) {
      const dir = tempDir('ai-review-switch-')
      const output = join(dir, 'output')
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output }
      if (value !== undefined) env.AI_REVIEW = value
      const result = spawnSync('bash', ['-c', switchStep.run ?? ''], { env, encoding: 'utf8' })
      expect(result.status, `${value}: ${result.stderr}`).toBe(0)
      const written = readFileSync(output, 'utf8')
      if (value === 'on') {
        expect(written).toContain('enabled=true')
      } else {
        expect(result.stdout, String(value)).toContain('AI review disabled (AI_REVIEW=off)')
        expect(written, String(value)).toContain('enabled=false')
        expect(written, String(value)).not.toContain('enabled=true')
      }
    }
  })

  it('reviews read-only with a modest turn limit and structured output', () => {
    const reviews = steps.filter((step) => step.uses === action)
    expect(reviews).toHaveLength(1)
    const review = reviews[0]
    expect(review.with?.anthropic_api_key).toBe('${{ secrets.ANTHROPIC_API_KEY }}')
    expect(review.with?.github_token).toBe('${{ github.token }}')

    const args = String(review.with?.claude_args ?? '')
    expect(args).toContain('--max-turns 20')
    expect(args).toContain('--json-schema')
    const disallowed = option(args, '--disallowedTools').split(',')
    expect(disallowed).toEqual(expect.arrayContaining(['Edit', 'Write']))
    const allowed = option(args, '--allowedTools').split(',')
    expect(allowed.length).toBeGreaterThan(0)
    for (const tool of allowed) {
      expect(tool).not.toMatch(/^(Edit|MultiEdit|Write|NotebookEdit|Bash)$/)
      if (tool.startsWith('Bash(')) expect(tool).toMatch(/^Bash\(gh pr (diff|view)/)
    }

    const prompt = String(review.with?.prompt ?? '')
    for (const word of ['P0', 'P1', 'P2', '/config.js', 'XSS', 'Type:']) expect(prompt).toContain(word)
  })

  it('gates the merge after the review, even when the review step failed', () => {
    const last = steps[steps.length - 1]
    expect(last.run).toContain('bash scripts/ai-review-report.sh')
    expect(last.if).toContain('!cancelled()')
    expect(last.if).toContain(enabled)
    expect(last.env?.RESULT).toContain('steps.review.outputs.structured_output')
    const reviewIndex = steps.findIndex((step) => step.uses === action)
    expect(steps[reviewIndex].id).toBe('review')
    expect(reviewIndex).toBeLessThan(steps.length - 1)
  })

  it('keeps expressions out of run scripts and secrets out of the file', () => {
    for (const step of steps) expect(step.run ?? '').not.toContain('${{')
    const secrets = text.match(/secrets\.[A-Z_]+/g) ?? []
    expect(secrets.length).toBeGreaterThan(0)
    for (const secret of secrets) expect(secret).toBe('secrets.ANTHROPIC_API_KEY')
    expect(text).not.toMatch(/sk-ant-|ghp_|github_pat_|xox[bp]-/)
  })
})
