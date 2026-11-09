import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
try { sessionStorage.removeItem('fa-onarim') } catch (e) { /* yoksay */ }
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <div className="fa-shell">
      <div className="fa-header">
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>Finansal Analiz</h1>
        <p style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Mizan bazli gelir tablosu, bilanco, analiz ve raporlama</p>
      </div>
      <ErrorBoundary><App /></ErrorBoundary>
    </div>
  </React.StrictMode>
)
