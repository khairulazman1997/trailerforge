import { useState } from 'react';
import { isLoopbackUrl, saveConnection, type Connection } from '../connection.js';

export function ConnectPage({
  error,
  onConnect,
}: {
  error: string | null;
  onConnect: (c: Connection) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [token, setToken] = useState('');
  const valid = isLoopbackUrl(baseUrl) && token.trim().length > 0;
  return (
    <main className="page narrow">
      <h1>Connect to TrailerForge</h1>
      <p>
        Start the engine with <code>tforge serve --ui apps/ui/dist</code> and open the link it
        prints. Or paste its address and token here.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const c = { baseUrl: baseUrl.trim().replace(/\/+$/, ''), token: token.trim() };
          saveConnection(c);
          onConnect(c);
        }}
      >
        <label>
          Service address
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
        </label>
        {!isLoopbackUrl(baseUrl) && (
          <p className="hint">Only local addresses (127.0.0.1, localhost) are accepted.</p>
        )}
        <label>
          Token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button type="submit" className="primary" disabled={!valid}>
          Connect
        </button>
      </form>
    </main>
  );
}
