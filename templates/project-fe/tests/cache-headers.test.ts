import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { repoRoot, runScript, tempDir } from './support.ts'

const nginx = readFileSync(join(repoRoot, 'nginx.conf'), 'utf8')

/** The body of the nginx `location <match> { ... }` block (no nested blocks in this config). */
function location(match: string): string {
  const start = nginx.indexOf(`location ${match} {`)
  expect(start, `location ${match}`).toBeGreaterThanOrEqual(0)
  return nginx.slice(start, nginx.indexOf('}', start))
}

function dist(files: Record<string, string>): string {
  const dir = tempDir('dist-')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const indexHtml = (script: string) =>
  `<!doctype html><html><head><script src="/config.js"></script><script type="module" crossorigin src="${script}"></script><link rel="stylesheet" crossorigin href="/assets/index-Bx3k9_Q-.css"></head></html>`

function checkHashes(dir: string) {
  return runScript('scripts/check-asset-hashes.sh', [dir], {})
}

describe('nginx cache headers', () => {
  it('makes browsers revalidate index.html, at / and on the SPA fallback', () => {
    expect(location('/')).toContain('add_header Cache-Control "no-cache";')
    expect(location('= /index.html')).toContain('add_header Cache-Control "no-cache";')
  })

  it('never caches the runtime config', () => {
    expect(location('= /config.js')).toContain('add_header Cache-Control "no-store";')
  })

  it('caches the hashed bundle for good', () => {
    expect(location('/assets')).toContain('add_header Cache-Control "public, immutable";')
  })
})

describe('scripts/check-asset-hashes.sh', () => {
  it('passes a bundle whose JS and CSS names carry a content hash', () => {
    const dir = dist({
      'index.html': indexHtml('/assets/index-D4kq1x_Z.js'),
      'assets/index-D4kq1x_Z.js': '',
      'assets/index-Bx3k9_Q-.css': '',
      'assets/logo-a1B2c3D4.svg': '',
    })
    const result = checkHashes(dir)
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('fails an unhashed bundle file', () => {
    const result = checkHashes(dist({ 'index.html': indexHtml('/assets/index-D4kq1x_Z.js'), 'assets/index.js': '' }))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('assets/index.js')
  })

  it('fails a script outside assets/', () => {
    const result = checkHashes(dist({ 'index.html': indexHtml('/assets/index-D4kq1x_Z.js'), 'app-D4kq1x_Z.js': '' }))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('app-D4kq1x_Z.js')
  })

  it('fails index.html loading an unhashed script', () => {
    const result = checkHashes(dist({ 'index.html': indexHtml('/assets/app.js') }))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('/assets/app.js')
  })

  it('needs an existing directory', () => {
    expect(checkHashes(join(tempDir('no-dist-'), 'dist')).status).toBe(2)
  })
})

describe('Front CI', () => {
  it('checks the bundle names after the build', () => {
    const workflow = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'front-ci.yml'), 'utf8')) as {
      jobs: { ci: { steps: { run?: string }[] } }
    }
    const steps = workflow.jobs.ci.steps
    const build = steps.findIndex((step) => step.run === 'npm run build')
    const check = steps.findIndex((step) => step.run === 'bash scripts/check-asset-hashes.sh dist')
    expect(build).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(build)
  })
})
