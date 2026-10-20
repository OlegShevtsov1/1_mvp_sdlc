import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, runScript, tempDir } from './support.ts'

const sha = 'c'.repeat(40)
const tagObject = 'd'.repeat(40)
let bin: string

/** A fake gh answering the two git-data reads of tag_check.sh: the tag ref, then the tag object. */
function fakeGh(refType: string | null) {
  fakeCommand(
    bin,
    'gh',
    `case "$*" in
  *repos/owner/repo/git/ref/tags/v1.2.3*) ${refType ? `echo "${refType} ${tagObject}"` : 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'} ;;
  *repos/owner/repo/git/tags/${tagObject}*) echo "commit ${sha}" ;;
  *) exit 1 ;;
esac`,
  )
}

function check(tag: string) {
  return runScript('deploy/tag_check.sh', [tag], { PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'owner/repo' })
}

beforeEach(() => {
  bin = tempDir('tag-check-')
})

describe('deploy/tag_check.sh', () => {
  it('resolves an annotated release tag to the commit sha', () => {
    fakeGh('tag')
    const result = check('v1.2.3')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(`version=sha-${sha}\nsha=${sha}\n`)
  })

  it('refuses a lightweight tag', () => {
    fakeGh('commit')
    const result = check('v1.2.3')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('v1.2.3 is a lightweight tag; prod needs an annotated tag')
  })

  it('refuses a tag that does not exist', () => {
    fakeGh(null)
    const result = check('v1.2.3')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('v1.2.3 does not exist')
  })

  it.each(['v1.2', `sha-${sha}`, 'main'])('refuses %j without asking GitHub', (tag) => {
    fakeGh('tag')
    const result = check(tag)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('release tag vX.Y.Z')
    expect(calls(bin, 'gh')).toEqual([])
  })
})
