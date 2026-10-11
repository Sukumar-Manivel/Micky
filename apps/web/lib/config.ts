// NEXT_PUBLIC_* variables are inlined into the browser bundle at build time,
// so this must never hold a secret. It is only the address of the API.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const API_BASE = `${API_URL}/api/v1`;
