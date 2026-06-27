import './monaco-setup'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/settings.css'
import './styles/room.css'
import { APP_NAME } from '@shared/appConfig'

document.title = APP_NAME

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
