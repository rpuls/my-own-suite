import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { startThemeFollowing } from './lib/theme';
import './styles/index.css';

startThemeFollowing();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
