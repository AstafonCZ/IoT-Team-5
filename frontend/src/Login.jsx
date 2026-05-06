import { useState } from 'react';
import { apiFetch } from './api';

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        onSuccess();
      } else if (res.status >= 500 || res.status === 502 || res.status === 503 || res.status === 0) {
        setError('Service unavailable — please try again later');
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Invalid credentials');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-box" onSubmit={submit} noValidate>
        <div className="login-title">PortalView</div>
        <div className="login-subtitle">Sign in to continue</div>

        <label className="login-label" htmlFor="pv-user">Username</label>
        <input
          id="pv-user"
          className="login-input"
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={e => setUsername(e.target.value)}
        />

        <label className="login-label" htmlFor="pv-pass">Password</label>
        <input
          id="pv-pass"
          className="login-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        {error && <div className="login-error">{error}</div>}

        <button className="login-btn" type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

