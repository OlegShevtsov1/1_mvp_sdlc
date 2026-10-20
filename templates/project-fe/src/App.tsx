import { useEffect, useState } from 'react'
import './App.css'
import type { AppConfig } from './config.ts'
import type { ErrorTest } from './errorTest.ts'

interface AppProps {
  config: AppConfig
  errorTest: ErrorTest | null
}

function RenderErrorTest({ marker }: { marker: string }): never {
  throw new Error(`error-test render ${marker}`)
}

async function fetchApiStatus(apiUrl: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(`${apiUrl}/health`, { signal })
    if (!response.ok) return 'unreachable'
    const body: unknown = await response.json()
    const reported = typeof body === 'object' && body !== null && 'status' in body ? body.status : null
    return typeof reported === 'string' ? reported : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

function App({ config, errorTest }: AppProps) {
  const apiUrl = config.API_URL
  const [apiStatus, setApiStatus] = useState(apiUrl ? 'checking…' : 'not configured')

  useEffect(() => {
    if (!apiUrl) return
    const controller = new AbortController()
    fetchApiStatus(apiUrl, controller.signal).then((status) => {
      if (!controller.signal.aborted) setApiStatus(status)
    })
    return () => controller.abort()
  }, [apiUrl])

  return (
    <div className="App">
      <header className="App-header">
        <h1>{{APP_MODULE}} App</h1>
        <p>Welcome to the {{APP_MODULE}} application</p>
        <p className="api-info">API: {apiUrl || 'not configured'}</p>
        <p className="api-info">Environment: {config.ENV_NAME}</p>
        <p className="api-info" data-testid="api-status">API status: {apiStatus}</p>
        {errorTest?.kind === 'render' && <RenderErrorTest marker={errorTest.marker} />}
      </header>
    </div>
  )
}

export default App
