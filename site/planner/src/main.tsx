import React from 'react';
import ReactDOM from 'react-dom/client';
import Home from '@/app/page';
// The synced MOS brand stylesheet (single source of truth: branding/styles/
// mos.css → npm run branding:sync). The editor wears the default dark MOS
// product look; only the graphic itself has a light/dark choice.
import '../../generated/branding/mos.css';
import '@/app/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
