// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ErrorFallback from './ErrorFallback.tsx'

describe('ErrorFallback', () => {
  afterEach(cleanup)

  it('says the error was reported when Sentry is on', () => {
    render(<ErrorFallback reported />)
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong. The error was reported.')
  })

  it('claims no report when Sentry is off', () => {
    render(<ErrorFallback reported={false} />)
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong.')
  })
})
