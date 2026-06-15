import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { Analytics } from "@vercel/analytics/react";
import Root from './Root.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
    <Analytics />
  </StrictMode>,
);
