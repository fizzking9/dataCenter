import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { t } from './i18n/zh-CN.js';
import './styles.css';

// The static document title is a pre-hydration fallback; the catalog owns it.
document.title = t('app.name');

const container = document.getElementById('root');
if (container === null) {
  throw new Error('The application root element is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);