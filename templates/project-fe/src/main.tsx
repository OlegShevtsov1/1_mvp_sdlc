import * as Sentry from '@sentry/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorFallback from './ErrorFallback.tsx'
import { readConfig } from './config.ts'
import { parseErrorTest, triggerErrorTest } from './errorTest.ts'
import { initSentry } from './sentry.ts'

const config = readConfig(window.APP_CONFIG)
const errorsReported = initSentry(config)

const errorTest = parseErrorTest(window.location.search)
if (errorTest) triggerErrorTest(errorTest)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback reported={errorsReported} />}>
      <App config={config} errorTest={errorTest} />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
