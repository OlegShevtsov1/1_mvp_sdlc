import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseErrorTest, triggerErrorTest } from './errorTest.ts'

describe('parseErrorTest', () => {
  it.each(['runtime', 'rejection', 'render'] as const)('reads ?error-test=%s with a marker', (kind) => {
    expect(parseErrorTest(`?error-test=${kind}&marker=e2e-${kind}-1`)).toEqual({ kind, marker: `e2e-${kind}-1` })
  })

  it.each([
    ['no parameters', ''],
    ['an unknown kind', '?error-test=network&marker=m1'],
    ['a missing marker', '?error-test=runtime'],
    ['a marker with markup', '?error-test=runtime&marker=%3Cb%3E'],
    ['a marker over 64 characters', `?error-test=runtime&marker=${'a'.repeat(65)}`],
  ])('ignores %s', (_, search) => {
    expect(parseErrorTest(search)).toBeNull()
  })
})

describe('triggerErrorTest', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('throws an uncaught runtime error carrying the marker', () => {
    vi.useFakeTimers()
    triggerErrorTest({ kind: 'runtime', marker: 'm1' })
    expect(() => vi.runAllTimers()).toThrow('error-test runtime m1')
  })

  it('leaves a rejected promise unhandled, carrying the marker', async () => {
    const reject = vi.spyOn(Promise, 'reject')
    triggerErrorTest({ kind: 'rejection', marker: 'm2' })
    expect(reject).toHaveBeenCalledWith(new Error('error-test rejection m2'))
    await reject.mock.results[0].value.catch(() => {})
  })
})
