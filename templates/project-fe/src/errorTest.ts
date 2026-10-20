// Deliberate front-end errors for checking error reporting end to end:
// /?error-test=runtime|rejection|render&marker=<id>. The marker ends up in the
// event message, so each check can find its own event in the error tracker.

const kinds = ['runtime', 'rejection', 'render'] as const

export interface ErrorTest {
  kind: (typeof kinds)[number]
  marker: string
}

function isKind(value: string | null): value is ErrorTest['kind'] {
  return kinds.some((kind) => kind === value)
}

export function parseErrorTest(search: string): ErrorTest | null {
  const params = new URLSearchParams(search)
  const kind = params.get('error-test')
  const marker = params.get('marker') ?? ''
  if (!isKind(kind) || !/^[A-Za-z0-9-]{1,64}$/.test(marker)) return null
  return { kind, marker }
}

export function triggerErrorTest({ kind, marker }: ErrorTest): void {
  if (kind === 'runtime') {
    setTimeout(() => {
      throw new Error(`error-test runtime ${marker}`)
    })
  } else if (kind === 'rejection') {
    void Promise.reject(new Error(`error-test rejection ${marker}`))
  }
}
