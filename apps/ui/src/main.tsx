import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StoreProvider } from './app-context.js';
import { makeClient } from './client.js';
import { loadConnection } from './connection.js';
import { AppStore } from './store.js';
import './styles.css';

const store = new AppStore(makeClient);
// Read the link/saved connection once, outside React: it also scrubs the token from the address bar.
const connection = loadConnection();
if (connection) void store.connect(connection);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
