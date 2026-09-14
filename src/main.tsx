import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { logger } from './app/logger';
import { captureUncaughtErrors } from './lib/logger';
import './styles.css';

captureUncaughtErrors(logger, window);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('index.html is missing the #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
