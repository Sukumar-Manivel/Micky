// Boots the whole Micky stack for the browser tests, and stops it again:
//   PostgreSQL (fresh database, migrated and seeded) and Redis (flushed db) must be running;
//   verifier (Python), API, worker and web (Node) are started here as child processes.
//
// Each child runs in its own process group (detached), so teardown can kill it together
// with anything it spawned (ffmpeg, uvicorn workers). Pids go to e2e/.stack/pids.json, so
// even a crashed run can be cleaned up by the next one.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API,
  API_DIR,
  API_PORT,
  API_URL,
  DATABASE_URL,
  INTERNAL_TOKEN,
  REDIS_URL,
  STACK_DIR,
  STORAGE_DIR,
  UPLOAD_TMP_DIR,
  VERIFIER_DIR,
  VERIFIER_PORT,
  VERIFIER_URL,
  WEB_DIR,
  WEB_PORT,
  WEB_URL,
  verifierPython,
} from './env.js';

const PIDS_FILE = path.join(STACK_DIR, 'pids.json');

/** Environment shared by the API and the worker: they must agree on every value. */
export function apiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    PUBLIC_API_URL: API_URL,
    WEB_URL,
    CORS_ORIGINS: WEB_URL,
    DATABASE_URL,
    REDIS_URL,
    JWT_ACCESS_SECRET: 'e2e-jwt-access-secret-0123456789abcdef',
    SIGNING_SECRET: 'e2e-signing-secret-0123456789abcdef',
    INTERNAL_TOKEN,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: STORAGE_DIR,
    UPLOAD_TMP_DIR,
    VERIFIER_URL,
    PAYMENTS_PROVIDER: 'mock',
    PLATFORM_FEE_PERCENT: '30',
    // Sale credits are normally held 7 days before payout (refund window); the money path pays out at once.
    EARNINGS_HOLD_DAYS: '0',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ADMIN_NAME: 'E2E Admin',
  };
}

// ---------------------------------------------------------------------------
// Database and Redis
// ---------------------------------------------------------------------------

/** Drops and recreates the e2e database, so every run starts from nothing. */
export async function recreateDatabase(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('e2e')) {
    // Refuse to drop anything that doesn't look like a throwaway e2e database.
    throw new Error(`E2E_DATABASE_URL must name a database containing "e2e", got "${dbName}"`);
  }
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(): Promise<void> {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.includes('e2e')) return;
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/** FLUSHDB on the e2e Redis database, over a raw socket (no client library needed). */
export async function flushRedis(): Promise<void> {
  const url = new URL(REDIS_URL);
  const db = Number(url.pathname.slice(1) || '0');
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(Number(url.port || 6379), url.hostname);
    let reply = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Redis did not answer FLUSHDB')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      reply += chunk.toString();
      // Two replies expected: +OK for SELECT, +OK for FLUSHDB.
      if ((reply.match(/\r\n/g) ?? []).length >= 2) {
        socket.end();
        if (reply.includes('-')) reject(new Error(`Redis error: ${reply.trim()}`));
        else resolve();
      }
    });
    socket.write(`SELECT ${db}\r\nFLUSHDB\r\n`);
  });
}

/** Applies the drizzle migrations and creates the admin, with the compiled API scripts. */
export function migrateAndSeed(): void {
  const env = apiEnv();
  execFileSync(process.execPath, ['dist/db/migrate.js'], { cwd: API_DIR, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['dist/db/seed.js'], { cwd: API_DIR, env, stdio: 'pipe' });
}

/** A short-lived query against the e2e database (used by tests to check what the UI can't show). */
export async function queryDb<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

interface Started {
  name: string;
  pid: number;
}

function startProcess(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Started {
  mkdirSync(STACK_DIR, { recursive: true });
  const log = openSync(path.join(STACK_DIR, `${name}.log`), 'w');
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  if (!child.pid) throw new Error(`Could not start ${name}`);
  child.unref();
  return { name, pid: child.pid };
}

async function waitForHttp(name: string, url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not become ready at ${url} (${last}). See ${path.join(STACK_DIR, `${name}.log`)}`);
}

async function waitForLog(name: string, pattern: RegExp, timeoutMs = 60_000): Promise<void> {
  const file = path.join(STACK_DIR, `${name}.log`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && pattern.test(readFileSync(file, 'utf8'))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not log ${pattern} in time. See ${file}`);
}

function requireBuilt(file: string, hint: string) {
  if (!existsSync(file)) throw new Error(`${file} is missing. ${hint}`);
}

/** Starts verifier, API, worker and web. Postgres and Redis must already be running. */
export async function startStack(): Promise<void> {
  stopStack(); // leftovers of a crashed earlier run
  requireBuilt(path.join(API_DIR, 'dist', 'main.js'), 'Build the API first: (cd apps/api && npm run build)');
  requireBuilt(path.join(WEB_DIR, '.next', 'standalone', 'server.js'), 'Build the web app first: (cd apps/web && npm run build)');

  // The standalone server needs the static assets next to it (as in apps/web/Dockerfile).
  const standalone = path.join(WEB_DIR, '.next', 'standalone');
  cpSync(path.join(WEB_DIR, '.next', 'static'), path.join(standalone, '.next', 'static'), { recursive: true });
  cpSync(path.join(WEB_DIR, 'public'), path.join(standalone, 'public'), { recursive: true });

  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(UPLOAD_TMP_DIR, { recursive: true, force: true });

  const python = existsSync(verifierPython()) ? verifierPython() : 'python3';
  const started: Started[] = [];
  const save = () => writeFileSync(PIDS_FILE, JSON.stringify(started, null, 2));
  try {
    started.push(
      startProcess(
        'verifier',
        python,
        ['-m', 'uvicorn', '--factory', 'app.main:app_factory', '--host', '127.0.0.1', '--port', String(VERIFIER_PORT)],
        VERIFIER_DIR,
        // No AI model in tests: the verifier still returns C2PA and pHash evidence.
        { ...process.env, INTERNAL_TOKEN, AI_MODEL_ENABLED: 'false', LOG_LEVEL: 'WARNING' },
      ),
    );
    save();
    const env = apiEnv();
    started.push(startProcess('api', process.execPath, ['dist/main.js'], API_DIR, env));
    save();
    started.push(startProcess('worker', process.execPath, ['dist/worker.js'], API_DIR, env));
    save();
    started.push(
      startProcess('web', process.execPath, ['server.js'], standalone, {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(WEB_PORT),
        HOSTNAME: '127.0.0.1',
        PUBLIC_API_URL: API_URL,
        NEXT_TELEMETRY_DISABLED: '1',
      }),
    );
    save();

    await Promise.all([
      waitForHttp('verifier', `${VERIFIER_URL}/health`),
      waitForHttp('api', `${API}/health`),
      waitForLog('worker', /Worker started/),
      waitForHttp('web', `${WEB_URL}/runtime-config.js`),
    ]);
  } catch (err) {
    stopStack();
    throw err;
  }
}

/** Kills every process group started by startStack (safe to call when nothing runs). */
export function stopStack(): void {
  if (!existsSync(PIDS_FILE)) return;
  const started = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as Started[];
  for (const { pid } of started) {
    try {
      process.kill(-pid, 'SIGTERM'); // the whole process group
    } catch {
      // already gone
    }
  }
  // Give them a moment to exit cleanly, then make sure.
  const deadline = Date.now() + 5000;
  for (const { pid } of started) {
    while (Date.now() < deadline && alive(pid)) execFileSync('sleep', ['0.1']);
    if (alive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  rmSync(PIDS_FILE, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
