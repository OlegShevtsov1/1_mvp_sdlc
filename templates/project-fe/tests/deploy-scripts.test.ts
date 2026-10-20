import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, fakeCrane, projectEnv, registryDigest, runScript, seedImage, tempDir } from './support.ts'

const { PROJECT_NAME: name, PROJECT_ZONE: zone } = projectEnv()
const sha = 'a'.repeat(40)
const version = `sha-${sha}`
const prodVersion = `prod-${version}`
const appUrl = `https://app.dev.${zone}`
const prodUrl = `https://app.${zone}`
const tag = 'v0.1.0'
const beSha = '7'.repeat(40)
const devLayers = ['sha256:layer-1', 'sha256:layer-2']

let bin: string
let configJs: string

function servedConfig(appVersion: string, envName = 'dev') {
  writeFileSync(configJs, `window.APP_CONFIG = {\n  ENV_NAME: "${envName}",\n  APP_VERSION: "${appVersion}",\n};\n`)
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return runScript(script, args, {
    PATH: `${bin}:${process.env.PATH}`,
    DEV_HOST: 'dev-host.invalid',
    PROD_VPN_IP: 'prod-host.invalid',
    SENTRY_DSN: 'SECRET-SENTINEL',
    ECR_REGISTRY: 'registry.invalid',
    KAMAL_REGISTRY_PASSWORD: 'SECRET-SENTINEL2',
    DEPLOY_WAIT_SECONDS: '1',
    DEPLOY_POLL_SECONDS: '1',
    GH_REPO: 'owner/repo',
    BE_REPO: 'owner/be',
    ...env,
  })
}

beforeEach(() => {
  bin = tempDir('deploy-bin-')
  configJs = join(bin, 'config.js')
  fakeCommand(bin, 'kamal')
  fakeCrane(bin)
  fakeCommand(bin, 'aws', 'echo "aws must not be called when ECR_REGISTRY and the password are set" >&2; exit 1')
  fakeCommand(
    bin,
    'curl',
    `case "\${@: -1}" in
  https://${zone}/health) echo '{"status":"ok","release":"${beSha}"}' ;;
  */health) echo ok ;;
  */config.js) cat "${configJs}" ;;
  *) exit 22 ;;
esac`,
  )
  servedConfig(version)
})

describe('deploy/deploy.sh', () => {
  it('deploys the pushed image with Kamal and waits until the app serves that version', () => {
    const result = run('deploy/deploy.sh', ['dev', version])
    expect(result.status, result.stderr).toBe(0)
    expect(calls(bin, 'kamal')).toEqual([`deploy -d dev --skip-push --version ${version}`])
    expect(calls(bin, 'curl').join('\n')).toContain(`${appUrl}/health`)
    expect(result.stdout).toContain(`ready: ${version}`)
    const output = result.stdout + result.stderr
    expect(output).not.toContain('SECRET-SENTINEL')
    expect(calls(bin, 'crane')).toEqual([])
  })

  it('gets the registry and its password from AWS when they are not set', () => {
    fakeCommand(
      bin,
      'aws',
      `case "$1 $2" in
  "sts get-caller-identity") echo fake-account ;;
  "ecr get-login-password") echo SECRET-SENTINEL2 ;;
  *) exit 1 ;;
esac`,
    )
    const result = run('deploy/deploy.sh', ['dev', version], { ECR_REGISTRY: '', KAMAL_REGISTRY_PASSWORD: '' })
    expect(result.status, result.stderr).toBe(0)
    expect(calls(bin, 'aws')).toHaveLength(2)
    expect(result.stdout + result.stderr).not.toContain('SECRET-SENTINEL')
  })

  it('refuses an unknown destination', () => {
    const result = run('deploy/deploy.sh', ['staging', version])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unknown destination 'staging'")
    expect(calls(bin, 'kamal')).toEqual([])
  })

  it('names missing variables without deploying', () => {
    const result = run('deploy/deploy.sh', ['dev', version], { DEV_HOST: '', SENTRY_DSN: '' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DEV_HOST')
    expect(result.stderr).toContain('SENTRY_DSN')
    expect(calls(bin, 'kamal')).toEqual([])
  })

  it.each([sha, 'sha-abc', `sha-${'A'.repeat(40)}`, ''])('rejects version %j', (bad) => {
    const result = run('deploy/deploy.sh', ['dev', bad])
    expect(result.status).toBe(1)
    expect(calls(bin, 'kamal')).toEqual([])
  })

  it('fails when the app never serves the new version', () => {
    servedConfig(`sha-${'b'.repeat(40)}`)
    const result = run('deploy/deploy.sh', ['dev', version])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('not ready after 1s')
  })

  it('fails when the app serves the version under another environment name', () => {
    servedConfig(version, 'prod')
    const result = run('deploy/deploy.sh', ['dev', version])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('not ready after 1s')
  })

  it('stops when Kamal fails', () => {
    fakeCommand(bin, 'kamal', 'exit 1')
    const result = run('deploy/deploy.sh', ['dev', version])
    expect(result.status).not.toBe(0)
    expect(calls(bin, 'kamal')).toHaveLength(1)
    expect(calls(bin, 'curl')).toEqual([])
  })
})

describe('deploy/rollback.sh', () => {
  it('rolls back to the image of a git sha and waits until it is served', () => {
    const result = run('deploy/rollback.sh', ['dev', sha])
    expect(result.status, result.stderr).toBe(0)
    expect(calls(bin, 'kamal')).toEqual([`rollback -d dev ${version}`])
    expect(result.stdout).toContain(`ready: ${version}`)
  })

  it('fails when Kamal has no container for that version and the old one keeps serving', () => {
    servedConfig(`sha-${'b'.repeat(40)}`)
    const result = run('deploy/rollback.sh', ['dev', sha])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('not ready after 1s')
  })

  it('refuses unknown destinations and malformed shas', () => {
    expect(run('deploy/rollback.sh', ['staging', sha]).status).toBe(1)
    expect(run('deploy/rollback.sh', ['dev', 'abc']).status).toBe(1)
    expect(calls(bin, 'kamal')).toEqual([])
  })
})

describe('prod', () => {
  let devDigest: string

  function crane(command: string): string[] {
    return calls(bin, 'crane').filter((call) => call.startsWith(`${command} `))
  }

  function expectNoLeaks(result: { stdout: string; stderr: string }) {
    const output = result.stdout + result.stderr
    expect(output).not.toContain('SECRET-SENTINEL')
    expect(output).not.toContain('registry.invalid')
  }

  /** A fake gh: the tag v0.1.0 is annotated and points at `tagSha`, which is on main; `beStatus` is
   * how the backend on prod compares to the minimum backend version. */
  function fakeGh({ tagSha = sha, onMain = 'ahead', beStatus = 'ahead' } = {}) {
    fakeCommand(
      bin,
      'gh',
      `case "$*" in
  *repos/owner/repo/git/ref/tags/${tag}*) echo "tag ${'9'.repeat(40)}" ;;
  *repos/owner/repo/git/tags/${'9'.repeat(40)}*) echo "commit ${tagSha}" ;;
  *repos/owner/repo/compare/${tagSha}...main*) echo ${onMain} ;;
  *repos/owner/be/compare/*...${beSha}*) echo ${beStatus} ;;
  *) exit 1 ;;
esac`,
    )
  }

  beforeEach(() => {
    devDigest = seedImage(bin, version, { layers: devLayers, service: `${name}-fe-dev` })
    servedConfig(prodVersion, 'prod')
    fakeGh()
  })

  describe('deploy/deploy.sh prod', () => {
    it('promotes the dev image by label, deploys it and points prod-current at it', () => {
      const previous = seedImage(bin, 'prod-current', { layers: ['sha256:old'], service: `${name}-fe` })
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status, result.stderr).toBe(0)
      expect(crane('mutate')).toEqual([
        `mutate registry.invalid/${name}-front:${version} --label service=${name}-fe -t registry.invalid/${name}-front:${prodVersion}`,
      ])
      expect(calls(bin, 'kamal')).toEqual([`deploy -d prod --skip-push --version ${prodVersion}`])
      expect(calls(bin, 'curl').join('\n')).toContain(`${prodUrl}/health`)
      expect(result.stdout).toContain(`ready: ${prodVersion}`)
      expect(result.stdout).toContain('layers identical')
      const promoted = registryDigest(bin, prodVersion)
      expect(promoted).toBeDefined()
      expect(promoted).not.toBe(devDigest)
      expect(registryDigest(bin, 'prod-current')).toBe(promoted)
      expect(registryDigest(bin, 'prod-previous')).toBe(previous)
      expectNoLeaks(result)
    })

    it('reuses and verifies an existing prod image', () => {
      expect(run('deploy/promote.sh', [version]).status).toBe(0)
      const promoted = registryDigest(bin, prodVersion)
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status, result.stderr).toBe(0)
      expect(crane('mutate')).toHaveLength(1)
      expect(result.stdout).toContain(`${name}-front:${prodVersion} exists, verifying it`)
      expect(registryDigest(bin, prodVersion)).toBe(promoted)
    })

    it('fails before Kamal when Dev Deploy never built the version', () => {
      const missing = `sha-${'b'.repeat(40)}`
      fakeGh({ tagSha: 'b'.repeat(40) })
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`${name}-front:${missing} is not in ECR`)
      expect(result.stderr).toContain('Dev Deploy')
      expect(crane('mutate')).toEqual([])
      expect(calls(bin, 'kamal')).toEqual([])
      expectNoLeaks(result)
    })

    it('fails before Kamal when the existing prod image has other layers', () => {
      seedImage(bin, prodVersion, { layers: [...devLayers, 'sha256:extra'], service: `${name}-fe` })
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('layers differ')
      expect(calls(bin, 'kamal')).toEqual([])
    })

    it('fails before Kamal when the existing prod image is labelled for another service', () => {
      seedImage(bin, prodVersion, { layers: devLayers, service: `${name}-fe-dev` })
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`not labelled service=${name}-fe`)
      expect(calls(bin, 'kamal')).toEqual([])
    })

    it('names a missing PROD_VPN_IP without touching ECR or Kamal', () => {
      const result = run('deploy/deploy.sh', ['prod', tag], { PROD_VPN_IP: '' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('PROD_VPN_IP')
      expect(calls(bin, 'crane')).toEqual([])
      expect(calls(bin, 'kamal')).toEqual([])
    })

    it.each([version, sha])('refuses the commit %j: prod deploys only a release tag', (bad) => {
      const result = run('deploy/deploy.sh', ['prod', bad])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('prod deploys only a release tag vX.Y.Z')
      expect(calls(bin, 'gh')).toEqual([])
      expect(calls(bin, 'crane')).toEqual([])
      expect(calls(bin, 'kamal')).toEqual([])
    })

    it('refuses a tag whose commit is not on main', () => {
      fakeGh({ onMain: 'diverged' })
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain('is not a commit on main')
      expect(calls(bin, 'crane')).toEqual([])
      expect(calls(bin, 'kamal')).toEqual([])
    })

    it('refuses before anything needs prod secrets when the backend on prod is older than the minimum', () => {
      fakeGh({ beStatus: 'behind' })
      const result = run('deploy/deploy.sh', ['prod', tag], {
        PROD_VPN_IP: '',
        SENTRY_DSN: '',
        ECR_REGISTRY: '',
        KAMAL_REGISTRY_PASSWORD: '',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Release order is backend first')
      expect(result.stderr).toContain('Nothing was deployed.')
      expect(calls(bin, 'aws')).toEqual([])
      expect(calls(bin, 'crane')).toEqual([])
      expect(calls(bin, 'kamal')).toEqual([])
    })

    it('says which backend it checked once the release order is kept', () => {
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(`backend on prod ${beSha.slice(0, 7)} contains`)
    })

    it('is not ready while prod serves the version under another environment name', () => {
      servedConfig(prodVersion, 'dev')
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not ready after 1s')
      expect(crane('tag')).toEqual([])
    })

    it('moves no tag when Kamal fails', () => {
      fakeCommand(bin, 'kamal', 'exit 1')
      expect(run('deploy/deploy.sh', ['prod', tag]).status).not.toBe(0)
      expect(crane('tag')).toEqual([])
      expect(registryDigest(bin, 'prod-current')).toBeUndefined()
    })

    it('moves no tag when the app never serves the prod version', () => {
      servedConfig(version, 'prod')
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not ready after 1s')
      expect(crane('tag')).toEqual([])
    })

    it('fails without moving a tag when prod-current cannot be read', () => {
      const previous = seedImage(bin, 'prod-current', { layers: ['sha256:old'], service: `${name}-fe` })
      writeFileSync(
        join(bin, 'registry', 'prod-current.error'),
        `Error: GET https://registry.invalid/v2/${name}-front/manifests/prod-current: TOOMANYREQUESTS: Rate exceeded`,
      )
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`could not read ${name}-front:prod-current`)
      expect(crane('tag')).toEqual([])
      expect(registryDigest(bin, 'prod-current')).toBe(previous)
      expect(registryDigest(bin, 'prod-previous')).toBeUndefined()
      expectNoLeaks(result)
    })

    it('leaves the tags alone when prod-current is already live', () => {
      expect(run('deploy/deploy.sh', ['prod', tag]).status).toBe(0)
      const tagged = crane('tag').length
      const result = run('deploy/deploy.sh', ['prod', tag])
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('prod-current is already')
      expect(crane('tag')).toHaveLength(tagged)
    })
  })

  describe('deploy/rollback.sh prod', () => {
    it('rolls back to the prod image of a git sha and rotates the tags', () => {
      expect(run('deploy/promote.sh', [version]).status).toBe(0)
      const current = seedImage(bin, 'prod-current', { layers: ['sha256:newer'], service: `${name}-fe` })
      const result = run('deploy/rollback.sh', ['prod', sha], { ROLLBACK_CONFIRM: 'ROLLBACK-prod' })
      expect(result.status, result.stderr).toBe(0)
      expect(calls(bin, 'kamal')).toEqual([`rollback -d prod ${prodVersion}`])
      expect(result.stdout).toContain(`ready: ${prodVersion}`)
      expect(crane('mutate')).toHaveLength(1)
      expect(registryDigest(bin, 'prod-current')).toBe(registryDigest(bin, prodVersion))
      expect(registryDigest(bin, 'prod-previous')).toBe(current)
      expectNoLeaks(result)
    })

    it('moves no tag when the old version never comes back', () => {
      servedConfig(`prod-sha-${'b'.repeat(40)}`, 'prod')
      expect(run('deploy/rollback.sh', ['prod', sha], { ROLLBACK_CONFIRM: 'ROLLBACK-prod' }).status).not.toBe(0)
      expect(crane('tag')).toEqual([])
    })

    it('rolls back to prod-previous and back again, swapping prod-current and prod-previous', () => {
      const older = `prod-sha-${'b'.repeat(40)}`
      const olderDigest = seedImage(bin, older, { layers: ['sha256:older'], service: `${name}-fe` })
      seedImage(bin, 'prod-previous', { layers: ['sha256:older'], service: `${name}-fe` })
      expect(run('deploy/promote.sh', [version]).status).toBe(0)
      const newerDigest = registryDigest(bin, prodVersion)
      writeFileSync(join(bin, 'registry', 'prod-current.digest'), `${newerDigest}\n`)
      for (const part of ['manifest', 'config']) {
        writeFileSync(join(bin, 'registry', `prod-current.${part}`), readFileSync(join(bin, 'registry', `${prodVersion}.${part}`)))
      }

      servedConfig(older, 'prod')
      const back = run('deploy/rollback.sh', ['prod', 'prod-previous'], { ROLLBACK_CONFIRM: 'ROLLBACK-prod' })
      expect(back.status, back.stderr).toBe(0)
      expect(calls(bin, 'kamal')).toEqual([`rollback -d prod ${older}`])
      expect(registryDigest(bin, 'prod-current')).toBe(olderDigest)
      expect(registryDigest(bin, 'prod-previous')).toBe(newerDigest)
      expectNoLeaks(back)

      servedConfig(prodVersion, 'prod')
      const forward = run('deploy/rollback.sh', ['prod', 'prod-previous'], { ROLLBACK_CONFIRM: 'ROLLBACK-prod' })
      expect(forward.status, forward.stderr).toBe(0)
      expect(calls(bin, 'kamal').at(-1)).toBe(`rollback -d prod ${prodVersion}`)
      expect(registryDigest(bin, 'prod-current')).toBe(newerDigest)
      expect(registryDigest(bin, 'prod-previous')).toBe(olderDigest)
    })

    it.each(['', 'prod', 'rollback-prod'])(
      'refuses a prod rollback without the typed confirmation ROLLBACK-prod (got %j)',
      (confirm) => {
        expect(run('deploy/promote.sh', [version]).status).toBe(0)
        const result = run('deploy/rollback.sh', ['prod', sha], { ROLLBACK_CONFIRM: confirm })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('typed confirmation ROLLBACK-prod')
        expect(calls(bin, 'kamal')).toEqual([])
        expect(crane('tag')).toEqual([])
      },
    )

    it('refuses prod-previous before there is one', () => {
      const result = run('deploy/rollback.sh', ['prod', 'prod-previous'], { ROLLBACK_CONFIRM: 'ROLLBACK-prod' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('there is no prod-previous yet')
      expect(calls(bin, 'kamal')).toEqual([])
    })
  })

  describe('deploy/promote.sh', () => {
    it('promotes without the prod host, the DSN or Kamal', () => {
      const result = run('deploy/promote.sh', [version], { PROD_VPN_IP: '', SENTRY_DSN: '' })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        `Promoting ${name}-front:${version} to ${name}-front:${prodVersion} (label service=${name}-fe, no build)`,
      )
      expect(registryDigest(bin, prodVersion)).toBeDefined()
      expect(calls(bin, 'kamal')).toEqual([])
      expectNoLeaks(result)
    })

    it.each([sha, 'sha-abc', ''])('rejects version %j', (bad) => {
      expect(run('deploy/promote.sh', [bad]).status).toBe(1)
      expect(calls(bin, 'crane')).toEqual([])
    })
  })
})
