// Base URL for all backend API calls.
// In dev (Vite proxy), this is empty so relative paths are used.
// In prod with a separate backend subdomain, set VITE_API_BASE_URL=https://api.example.com
const BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export function apiUrl(path) {
  return `${BASE}${path}`;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { credentials: 'include', ...options });
}
