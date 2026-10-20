import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectEnv, repoRoot, runScript, tempDir } from './support.ts'

// Renders a Kamal config file the way Kamal does (ERB, then YAML) and returns it as JSON.
function renderKamalConfig(file: string) {
  const result = spawnSync(
    'ruby',
    ['-rerb', '-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load(ERB.new(File.read(ARGV[0])).result))', file],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DEV_HOST: 'dev-host.invalid',
        PROD_VPN_IP: 'prod-host.invalid',
        ECR_REGISTRY: 'registry.invalid',
      },
      encoding: 'utf8',
    },
  )
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

function preflightOutputs(): Record<string, string> {
  const output = join(tempDir('kamal-config-'), 'github_output')
  writeFileSync(output, '')
  const result = runScript('deploy/preflight.sh', ['dev'], {
    AWS_ROLE_ARN: 'x',
    VPN_CI_OVPN: 'x',
    SRV_DEPLOY_SSH_KEY: 'x',
    SENTRY_DSN: 'x',
    DEPLOY_SHA: 'a'.repeat(40),
    GITHUB_OUTPUT: output,
  })
  expect(result.status, result.stderr).toBe(0)
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

// Dev Deploy builds, tags and labels the image from the preflight outputs, while Kamal
// resolves the same names from the YAML; a mismatch would only surface at deploy time.
describe('Kamal dev config agrees with deploy/preflight.sh', () => {
  const base = renderKamalConfig('config/deploy.yml')
  const dev = renderKamalConfig('config/deploy.dev.yml')
  const outputs = preflightOutputs()

  it('pushes the image Kamal pulls', () => {
    expect(base.image).toBe(outputs.image)
  })

  it('labels the image with the Kamal service', () => {
    expect(dev.service).toBe(outputs.service)
  })

  it('waits on and announces the host the proxy routes', () => {
    expect(`https://${dev.proxy.host}`).toBe(outputs.url)
  })
})

function destinationUrl(destination: string): string {
  const result = spawnSync('bash', ['-c', 'source deploy/lib.sh && load_project_env && destination_url "$1"', '_', destination], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

// deploy/lib.sh derives the prod service label, URL and ENV_NAME from the same project.env.
describe('Kamal prod config', () => {
  const { PROJECT_NAME: name, PROJECT_ZONE: zone } = projectEnv()
  const prod = renderKamalConfig('config/deploy.prod.yml')

  it('serves the URL the prod scripts wait on', () => {
    expect(`https://${prod.proxy.host}`).toBe(destinationUrl('prod'))
  })

  it('runs the prod service on the prod host over the VPN', () => {
    expect(prod.service).toBe(`${name}-fe`)
    expect(prod.servers.web.hosts).toEqual(['prod-host.invalid'])
    expect(prod.ssh.user).toBe('ubuntu')
  })

  it('has kamal-proxy terminate TLS for the prod app host', () => {
    expect(prod.proxy).toEqual({ ssl: true, host: `app.${zone}` })
  })

  it('points the app at the prod API', () => {
    expect(prod.env.clear).toEqual({ API_URL: `https://${zone}`, ENV_NAME: 'prod' })
  })
})
