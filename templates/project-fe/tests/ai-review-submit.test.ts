import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, runScript, tempDir } from './support.ts'

interface Finding {
  severity: 'P0' | 'P1' | 'P2'
  path: string
  line: number
  title: string
  body: string
}

interface Payload {
  commit_id: string
  event: string
  body: string
  comments: { path: string; line: number; side: string; body: string }[]
}

const sha = 'a'.repeat(40)
const oldSha = 'b'.repeat(40)
const reviewsUrl = 'repos/owner/repo/pulls/7/reviews'
const diff = `diff --git a/src/App.tsx b/src/App.tsx
index 1111111..2222222 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -10,3 +10,4 @@ export function App() {
 line ten
 line eleven
+line twelve
 line thirteen
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-gone too
`

// Three hunks of one file (removed lines, a gap, "\ No newline"), a new file whose path has a space (git
// ends it with a tab) and C-quoted paths, non-ASCII and with a quote.
const multiHunkDiff = `diff --git a/src/z.ts b/src/z.ts
index 1111111..2222222 100644
--- a/src/z.ts
+++ b/src/z.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -20,4 +20,3 @@ function z() {
 twenty
-twenty-one
-twenty-two
+twenty-one and two
 twenty-three
@@ -30,2 +30,3 @@ function z() {
 keep
-old last
\\ No newline at end of file
+new last
+added
\\ No newline at end of file
diff --git a/src/new file.ts b/src/new file.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/new file.ts\t
@@ -0,0 +1 @@
+only line
diff --git "a/src/\\303\\244 b.ts" "b/src/\\303\\244 b.ts"
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ "b/src/\\303\\244 b.ts"\t
@@ -0,0 +1,2 @@
+first
+second
diff --git "a/src/q\\"t.ts" "b/src/q\\"t.ts"
new file mode 100644
index 0000000..6666666
--- /dev/null
+++ "b/src/q\\"t.ts"
@@ -0,0 +1 @@
+quoted
`

let bin: string
let work: string

function finding(severity: Finding['severity'], path: string, line: number, title = `${severity} at ${path}:${line}`): Finding {
  return { severity, path, line, title, body: `Why ${title}.\nHow to fix it.` }
}

function botReview(id: number, commit_id: string, state: string) {
  const body = '<!-- ai-review -->\n### AI review\nAI-REVIEW: P0=0 P1=0 P2=0\n\nSummary.'
  return { id, user: { login: 'github-actions[bot]' }, commit_id, state, body }
}

/** A review by another workflow on the same token: the bot's login, but not this workflow's marker. */
function foreignBotReview(id: number, commit_id: string, state: string, body: string | null = 'Lint report') {
  return { id, user: { login: 'github-actions[bot]' }, commit_id, state, body }
}

/** Writes the gate's and the collect step's files for `findings` (`files` overrides them, null leaves one out), then runs the script. */
function submit(
  findings: Finding[],
  options: { reviews?: unknown; env?: Record<string, string>; files?: Record<string, string | null> } = {},
) {
  const dir = join(work, 'ai-review')
  mkdirSync(dir, { recursive: true })
  const n = (severity: string) => findings.filter((f) => f.severity === severity).length
  const [p0, p1, p2] = [n('P0'), n('P1'), n('P2')]
  const files: Record<string, string | null> = {
    head_sha: `${sha}\n`,
    'pr.diff': diff,
    'findings.json': JSON.stringify(findings),
    'result.json': JSON.stringify({ p0, p1, p2 }),
    'comment.md': `<!-- ai-review -->\n### AI review\nAI-REVIEW: P0=${p0} P1=${p1} P2=${p2}\n\nSummary.\n\nRun: https://example.test/run/1\n`,
    ...options.files,
  }
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) writeFileSync(join(dir, name), content)
  }
  return runScript(
    'scripts/ai-review-submit.sh',
    ['ai-review'],
    {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'owner/repo',
      PR_NUMBER: '7',
      GH_TOKEN: 'test',
      REVIEWS: typeof options.reviews === 'string' ? options.reviews : JSON.stringify(options.reviews ?? []),
      ...options.env,
    },
    work,
  )
}

function payloads(): Payload[] {
  return readdirSync(bin)
    .filter((name) => /^payload-\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(bin, name), 'utf8')) as Payload)
}

const gh = (pattern: RegExp) => calls(bin, 'gh').filter((line) => pattern.test(line))

beforeEach(() => {
  bin = tempDir('ai-review-submit-bin-')
  work = tempDir('ai-review-submit-work-')
  // Keeps each --input payload, answers the review list with $REVIEWS and fails the first $FAIL_POSTS POSTs.
  fakeCommand(
    bin,
    'gh',
    `args=("$@")
for (( i = 0; i < \${#args[@]}; i++ )); do
  if [ "\${args[i]}" = --input ]; then
    n=$(( $(find "${bin}" -maxdepth 1 -name 'payload-*.json' | wc -l) + 1 ))
    cp "\${args[i + 1]}" "${bin}/payload-\${n}.json"
  fi
done
case "$*" in
  *--paginate*) printf '%s' "\${REVIEWS:-[]}" ;;
  *'-X POST'*)
    posts=$(( $(cat "${bin}/posts" 2>/dev/null || echo 0) + 1 ))
    echo "\${posts}" > "${bin}/posts"
    if [ "\${posts}" -le "\${FAIL_POSTS:-0}" ]; then echo 'gh: Unprocessable Entity (HTTP 422)' >&2; exit 1; fi ;;
esac`,
  )
})

describe('scripts/ai-review-submit.sh', () => {
  it('posts one review on the head, inline on diff lines and the rest in the body', () => {
    const run = submit([
      finding('P2', 'src/App.tsx', 11),
      finding('P2', 'src/App.tsx', 12),
      finding('P1', 'src/y.ts', 5),
      finding('P2', 'src/old.ts', 1),
      finding('P1', '', 0, 'Title convention'),
    ])
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(gh(/-X POST/)).toHaveLength(1)
    expect(gh(/-X POST/)[0]).toMatch(new RegExp(`^api -X POST ${reviewsUrl} --input `))
    const [payload] = payloads()
    expect(payload.commit_id).toBe(sha)
    expect(payload.comments).toEqual([
      { path: 'src/App.tsx', line: 11, side: 'RIGHT', body: '**P2** P2 at src/App.tsx:11\n\nWhy P2 at src/App.tsx:11.\nHow to fix it.' },
      { path: 'src/App.tsx', line: 12, side: 'RIGHT', body: '**P2** P2 at src/App.tsx:12\n\nWhy P2 at src/App.tsx:12.\nHow to fix it.' },
    ])
    expect(payload.body.startsWith('<!-- ai-review -->\n### AI review\nAI-REVIEW: P0=0 P1=2 P2=3\n')).toBe(true)
    expect(payload.body.endsWith('\n\nRun: https://example.test/run/1')).toBe(true)
    for (const text of [
      '### Findings outside the diff',
      '- **P1** `src/y.ts:5` P1 at src/y.ts:5',
      '  Why P1 at src/y.ts:5.',
      '- **P2** `src/old.ts:1`',
      '- **P1** Title convention',
    ])
      expect(payload.body).toContain(text)
    expect(payload.body).not.toContain('`src/App.tsx:11`')
    expect(payload.body).not.toContain('Truncated')
    expect(run.stdout).toContain(`AI review posted on PR #7 for ${sha}: REQUEST_CHANGES, 2 inline, 3 in the body`)
  })

  it('lists each finding outside the diff once and the inline ones not at all', () => {
    const findings = [
      finding('P2', 'src/App.tsx', 11),
      finding('P2', 'src/App.tsx', 12),
      finding('P1', 'src/y.ts', 5),
      finding('P2', 'src/old.ts', 1),
      finding('P1', '', 0, 'Title convention'),
    ]
    const report = runScript(
      'scripts/ai-review-report.sh',
      [],
      { RUN_URL: 'https://example.test/run/1', RESULT: JSON.stringify({ summary: 'Looks fine overall.', findings }) },
      work,
    )
    expect(report.stdout).toContain('P0=0 P1=2 P2=3')
    const run = submit(findings, { files: { 'comment.md': null, 'findings.json': null, 'result.json': null } })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const { body } = payloads()[0]
    expect(body).toContain('Looks fine overall.')
    for (const title of ['P1 at src/y.ts:5', 'P2 at src/old.ts:1', 'Title convention'])
      expect(body.split(`Why ${title}.`).length - 1, title).toBe(1)
    for (const text of ['src/App.tsx:11', 'src/App.tsx:12']) expect(body).not.toContain(text)
    expect(body).not.toContain('Truncated')
  })

  it('caps the body and every inline comment with a truncation note', () => {
    const long = (f: Finding): Finding => ({ ...f, body: 'x'.repeat(70000) })
    const run = submit([long(finding('P1', 'src/y.ts', 5)), long(finding('P2', 'src/App.tsx', 11))])
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const [payload] = payloads()
    expect(payload.body.length).toBeLessThanOrEqual(60000)
    expect(payload.body.startsWith('<!-- ai-review -->\n### AI review\nAI-REVIEW: P0=0 P1=1 P2=1\n')).toBe(true)
    expect(payload.body.endsWith('\n\nRun: https://example.test/run/1')).toBe(true)
    expect(payload.body).toContain('Truncated to fit GitHub')
    expect(payload.comments[0].body.length).toBeLessThanOrEqual(60000)
    expect(payload.comments[0].body).toContain('Truncated to fit GitHub')
  })

  it('anchors to the head lines of every hunk and file, whatever the path', () => {
    const inline: [string, number][] = [
      ['src/z.ts', 1], ['src/z.ts', 2], ['src/z.ts', 21], ['src/z.ts', 22], ['src/z.ts', 31], ['src/z.ts', 32],
      ['src/new file.ts', 1], ['src/ä b.ts', 2], ['src/q"t.ts', 1],
    ]
    const outside: [string, number][] = [
      ['src/z.ts', 4], ['src/z.ts', 19], ['src/z.ts', 23], ['src/z.ts', 33], ['src/new file.ts', 2], ['src/ä b.ts', 3],
    ]
    const run = submit(
      [...inline, ...outside].map(([path, line]) => finding('P2', path, line)),
      { files: { 'pr.diff': multiHunkDiff } },
    )
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const [payload] = payloads()
    expect(payload.comments.map((c) => [c.path, c.line])).toEqual(inline)
    for (const [path, line] of outside) expect(payload.body).toContain(`\`${path}:${line}\``)
  })

  it.each([
    ['a P1', [finding('P1', 'src/App.tsx', 11)], 'REQUEST_CHANGES'],
    ['a P0 only', [finding('P0', 'src/App.tsx', 11)], 'REQUEST_CHANGES'],
    ['P2 only', [finding('P2', 'src/App.tsx', 11)], 'COMMENT'],
    ['no findings', [], 'COMMENT'],
  ])('submits the right event for %s', (_, findings, event) => {
    const run = submit(findings)
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(payloads()[0].event).toBe(event)
  })

  it('leaves the outside section out when there is nothing outside the diff', () => {
    const run = submit([])
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(payloads()[0].comments).toEqual([])
    expect(payloads()[0].body).not.toContain('### Findings')
  })

  it('posts nothing when this bot already reviewed the head', () => {
    const run = submit([finding('P2', 'src/App.tsx', 11)], { reviews: [botReview(5, sha, 'COMMENTED')] })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).toContain('already posted')
    expect(gh(/-X (POST|PUT)/)).toEqual([])
  })

  it('still posts after a review by someone else on the head or by the bot on an older head', () => {
    const run = submit([], {
      reviews: [{ id: 6, user: { login: 'OlegShevtsov1' }, commit_id: sha, state: 'COMMENTED' }, botReview(7, oldSha, 'COMMENTED')],
    })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(gh(/-X POST/)).toHaveLength(1)
  })

  it.each([
    ['another body', 'Lint report'],
    ['no body', null],
  ])('still posts after a github-actions[bot] review with %s on the head', (_, body) => {
    const run = submit([], { reviews: [foreignBotReview(5, sha, 'COMMENTED', body)] })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(gh(/-X POST/)).toHaveLength(1)
  })

  it('reads every page of the review list', () => {
    const run = submit([], { reviews: `[]\n${JSON.stringify([botReview(5, sha, 'COMMENTED')])}` })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(gh(/-X POST/)).toEqual([])
  })

  describe('dismissing the earlier Request changes', () => {
    const reviews = [
      botReview(77, oldSha, 'CHANGES_REQUESTED'),
      { id: 78, user: { login: 'OlegShevtsov1' }, commit_id: oldSha, state: 'CHANGES_REQUESTED' },
      botReview(79, oldSha, 'COMMENTED'),
    ]

    it("dismisses only this bot's Request changes once the result is clean", () => {
      const run = submit([finding('P2', 'src/App.tsx', 11)], { reviews })
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(gh(/-X PUT/)).toEqual([
        `api -X PUT ${reviewsUrl}/77/dismissals -f message=Superseded by the AI review of ${sha} -f event=DISMISS`,
      ])
    })

    it("leaves another workflow's github-actions[bot] Request changes alone", () => {
      const run = submit([], { reviews: [foreignBotReview(81, oldSha, 'CHANGES_REQUESTED'), botReview(77, oldSha, 'CHANGES_REQUESTED')] })
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(gh(/-X PUT/)).toEqual([
        `api -X PUT ${reviewsUrl}/77/dismissals -f message=Superseded by the AI review of ${sha} -f event=DISMISS`,
      ])
    })

    it('retries the dismissal on a head already reviewed, its own Request changes included', () => {
      const run = submit([], { reviews: [botReview(77, oldSha, 'CHANGES_REQUESTED'), botReview(80, sha, 'CHANGES_REQUESTED')] })
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(run.stdout).toContain('already posted')
      expect(gh(/-X POST/)).toEqual([])
      expect(gh(/-X PUT/)).toEqual([
        `api -X PUT ${reviewsUrl}/77/dismissals -f message=Superseded by the AI review of ${sha} -f event=DISMISS`,
        `api -X PUT ${reviewsUrl}/80/dismissals -f message=Superseded by the AI review of ${sha} -f event=DISMISS`,
      ])
    })

    it('keeps it while P0/P1 remain', () => {
      const run = submit([finding('P1', 'src/App.tsx', 11)], { reviews })
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(gh(/-X PUT/)).toEqual([])
    })

    it('still dismisses when the review could not be posted', () => {
      const run = submit([], { reviews, env: { FAIL_POSTS: '2' } })
      expect(run.status).toBe(1)
      expect(gh(/-X PUT/)).toHaveLength(1)
    })
  })

  it('retries once with every finding in the body when the inline comments are rejected', () => {
    const run = submit([finding('P2', 'src/App.tsx', 11), finding('P1', 'src/y.ts', 5)], { env: { FAIL_POSTS: '1' } })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(gh(/-X POST/)).toHaveLength(2)
    const retry = payloads()[1]
    expect(retry.comments).toEqual([])
    expect(retry.event).toBe('REQUEST_CHANGES')
    for (const text of ['### Findings', '- **P2** `src/App.tsx:11`', '- **P1** `src/y.ts:5`']) expect(retry.body).toContain(text)
    expect(retry.body).not.toContain('### Findings outside the diff')
  })

  it('does not retry a rejected review that had no inline comments', () => {
    const run = submit([finding('P1', 'src/y.ts', 5)], { env: { FAIL_POSTS: '1' } })
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('::warning::AI review could not be posted on PR #7')
    expect(gh(/-X POST/)).toHaveLength(1)
  })

  it('warns and exits 1 when the retry fails too', () => {
    const run = submit([finding('P2', 'src/App.tsx', 11)], { env: { FAIL_POSTS: '2' } })
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('::warning::AI review could not be posted on PR #7')
    expect(gh(/-X POST/)).toHaveLength(2)
  })

  it('treats the findings as data', () => {
    const touched = join(work, 'touched')
    const title = `$(touch ${touched}) \`touch ${touched}\``
    const run = submit([finding('P2', 'src/App.tsx', 11, title)])
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(existsSync(touched)).toBe(false)
    expect(payloads()[0].comments[0].body).toContain(title)
  })

  it.each([
    ['a missing findings.json', { 'findings.json': null }],
    ['a bad head_sha', { head_sha: 'main\n' }],
  ])('exits 2 with a usage message on %s, calling nothing', (_, files) => {
    const run = submit([], { files })
    expect(run.status).toBe(2)
    expect(run.stderr + run.stdout).toContain('usage')
    expect(calls(bin, 'gh')).toEqual([])
  })
})
