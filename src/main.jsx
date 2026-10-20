import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import App from './App.jsx';
import { ThemeProvider, useTheme } from './Theme.jsx';
import './styles.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
function ThemeToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster theme={resolvedTheme} position="bottom-center" richColors closeButton />;
}
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider><QueryClientProvider client={client}><App /><ThemeToaster /></QueryClientProvider></ThemeProvider>
  </React.StrictMode>,
);
