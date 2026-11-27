import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgentXProvider } from './state/store.jsx';
import App from './App.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AgentXProvider>
      <App />
    </AgentXProvider>
  </React.StrictMode>,
);
