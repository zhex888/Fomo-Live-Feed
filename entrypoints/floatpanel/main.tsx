import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Float panel root element was not found.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
