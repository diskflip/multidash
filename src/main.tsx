import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { armSoundUnlock } from './lib/sounds.ts'
import { enableAutoRefresh } from './lib/autoRefresh.ts'

armSoundUnlock()
enableAutoRefresh()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
