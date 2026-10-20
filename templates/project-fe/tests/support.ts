import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const repoRoot = join(import.meta.dirname, '..')

export function projectEnv(): Record<string, string> {
  const text = readFileSync(join(repoRoot, 'config', 'project.env'), 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Writes an executable that appends its arguments to `<dir>/<name>.calls`, then runs `body`. */
export function fakeCommand(dir: string, name: string, body = 'exit 0'): void {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/${name}.calls"\n${body}\n`)
  chmodSync(path, 0o755)
}

export function calls(dir: string, name: string): string[] {
  try {
    return readFileSync(join(dir, `${name}.calls`), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * A fake `crane` backed by `<dir>/registry`, which holds `<tag>.digest`, `<tag>.manifest` and
 * `<tag>.config` per image tag. References resolve by the tag after the last `:` or by `@<digest>`.
 * Reading an absent tag fails like ECR (MANIFEST_UNKNOWN); a `<tag>.error` file makes reads of that
 * tag fail with its content instead. `ls` lists the stored tags.
 */
export function fakeCrane(dir: string): void {
  mkdirSync(join(dir, 'registry'), { recursive: true })
  fakeCommand(
    dir,
    'crane',
    `registry="${dir}/registry"
tag_of() {
  case $1 in
    *@*)
      for file in "$registry"/*.digest; do
        if [ "$(cat "$file")" = "\${1#*@}" ]; then basename "$file" .digest; return 0; fi
      done
      return 1 ;;
    *) echo "\${1##*:}" ;;
  esac
}
case $1 in
  auth) cat >/dev/null ;;
  ls)
    for file in "$registry"/*.digest; do basename "$file" .digest; done ;;
  digest|manifest|config)
    tag=$(tag_of "$2") || exit 1
    if [ -f "$registry/$tag.error" ]; then cat "$registry/$tag.error" >&2; exit 1; fi
    [ -f "$registry/$tag.$1" ] || { echo "Error: GET $2: MANIFEST_UNKNOWN: Requested image not found" >&2; exit 1; }
    cat "$registry/$tag.$1" ;;
  mutate)
    src=$(tag_of "$2") && [ -f "$registry/$src.digest" ] || exit 1
    dst=$(tag_of "$6")
    cp "$registry/$src.manifest" "$registry/$dst.manifest"
    jq -c --arg service "\${4#service=}" '.config.Labels.service = $service' "$registry/$src.config" >"$registry/$dst.config"
    echo "sha256:$(sha256sum "$registry/$dst.config" | cut -c1-64)" >"$registry/$dst.digest" ;;
  tag)
    src=$(tag_of "$2") || exit 1
    for part in digest manifest config; do cp "$registry/$src.$part" "$registry/$3.$part"; done ;;
  *) exit 1 ;;
esac`,
  )
}

/** Stores an image in the fake crane registry and returns its digest. */
export function seedImage(dir: string, tag: string, image: { layers: string[]; service: string }): string {
  const manifest = JSON.stringify({ layers: image.layers.map((digest) => ({ digest })) })
  const config = JSON.stringify({
    rootfs: { type: 'layers', diff_ids: image.layers },
    config: { Env: ['NGINX_VERSION=1'], Labels: { service: image.service } },
  })
  const digest = `sha256:${createHash('sha256').update(manifest + config).digest('hex')}`
  writeFileSync(join(dir, 'registry', `${tag}.digest`), `${digest}\n`)
  writeFileSync(join(dir, 'registry', `${tag}.manifest`), manifest)
  writeFileSync(join(dir, 'registry', `${tag}.config`), config)
  return digest
}

/** The digest the fake crane registry holds for a tag, or undefined. */
export function registryDigest(dir: string, tag: string): string | undefined {
  const file = join(dir, 'registry', `${tag}.digest`)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

export function runScript(script: string, args: string[], env: Record<string, string>, cwd?: string) {
  return spawnSync('bash', [join(repoRoot, script), ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })
}

/** Runs git in `dir` and returns its trimmed output; throws when git fails. */
export function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A new git repository on branch main with a committer identity of its own. */
export function gitRepo(prefix: string): string {
  const dir = tempDir(prefix)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

/** Writes `files` (path to content) into `dir`, commits them and returns the commit's sha. */
export function commit(dir: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '--', ...Object.keys(files))
  git(dir, 'commit', '-q', '--no-verify', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}
