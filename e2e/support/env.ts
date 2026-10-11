// Where the e2e stack lives. Every value can be overridden with an environment variable,
// so CI (service containers) and a laptop (local Postgres/Redis) use the same code.
// Ports are deliberately not the dev defaults (3000/4000/8000), so a running dev stack
// does not clash with the test stack.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const E2E_DIR = path.join(ROOT, 'e2e');
export const API_DIR = path.join(ROOT, 'apps', 'api');
export const WEB_DIR = path.join(ROOT, 'apps', 'web');
export const VERIFIER_DIR = path.join(ROOT, 'services', 'verifier');

/** Generated test media (MP4s made with ffmpeg in global setup). */
export const FIXTURES_DIR = path.join(E2E_DIR, '.fixtures');
/** Process logs and pids of the stack started by global setup. */
export const STACK_DIR = path.join(E2E_DIR, '.stack');
/** The API's local file storage for this run (inside apps/api/tmp, which is git-ignored). */
export const STORAGE_DIR = path.join(API_DIR, 'tmp', 'e2e-storage');
export const UPLOAD_TMP_DIR = path.join(API_DIR, 'tmp', 'e2e-uploads');

const env = process.env;

export const API_PORT = Number(env.E2E_API_PORT ?? 4310);
export const WEB_PORT = Number(env.E2E_WEB_PORT ?? 3310);
export const VERIFIER_PORT = Number(env.E2E_VERIFIER_PORT ?? 8310);

export const API_URL = env.E2E_API_URL ?? `http://localhost:${API_PORT}`;
export const API = `${API_URL}/api/v1`;
export const WEB_URL = env.E2E_WEB_URL ?? `http://localhost:${WEB_PORT}`;
export const VERIFIER_URL = env.E2E_VERIFIER_URL ?? `http://localhost:${VERIFIER_PORT}`;

/** A fresh database is created (dropped first) for every run, unless E2E_EXTERNAL_STACK=1. */
export const DATABASE_URL =
  env.E2E_DATABASE_URL ?? 'postgresql://firstframe:firstframe@localhost:5432/firstframe_e2e';
/** Redis db index 13 by default, flushed at the start of a run. */
export const REDIS_URL = env.E2E_REDIS_URL ?? 'redis://localhost:6379/13';

/** Shared secret between the worker and the verifier. Must be identical on both sides. */
export const INTERNAL_TOKEN = env.E2E_INTERNAL_TOKEN ?? 'e2e-internal-token-0123456789abcdef';

/** The seeded admin (admins cannot self-register). */
export const ADMIN_EMAIL = env.E2E_ADMIN_EMAIL ?? 'admin@firstframe-e2e.test';
export const ADMIN_PASSWORD = env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password-123';

/** Set to 1 to test a stack you started yourself (nothing is booted, migrated or seeded). */
export const EXTERNAL_STACK = env.E2E_EXTERNAL_STACK === '1';

/** The Python that runs the verifier: the service's venv locally, `python3` in CI. */
export function verifierPython(): string {
  if (env.E2E_PYTHON) return env.E2E_PYTHON;
  return path.join(VERIFIER_DIR, '.venv', 'bin', 'python');
}
