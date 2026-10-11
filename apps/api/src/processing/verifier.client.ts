import { Injectable, Logger } from '@nestjs/common';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { AppConfig } from '../config/app-config.js';
import type { C2paStatus } from './risk.js';

/** The verifier's answer (docs/API.md, "Internal: worker → verifier service"). */
export interface VerifierResult {
  ai: { available: boolean; score: number | null; model: string | null; framesScored: number; frameScores: number[] };
  c2pa: { status: C2paStatus; issuer: string | null; claimGenerator: string | null };
  phashes: string[];
}

/**
 * The verifier could not give an answer.
 * - `retryable`: network error, timeout or 5xx. It may work in a minute, so the job is retried.
 * - not retryable: 4xx or a malformed answer. Asking again gives the same result.
 */
export class VerifierUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VerifierUnavailableError';
  }
}

/** The original is sent for the C2PA check only up to this size (the verifier's own limit). */
export const MAX_ORIGINAL_UPLOAD_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const C2PA_STATUSES = new Set<C2paStatus>(['valid', 'invalid', 'absent', 'error', 'unsupported']);

/** HTTP client for the internal Python verifier service. */
@Injectable()
export class VerifierClient {
  private readonly logger = new Logger(VerifierClient.name);

  constructor(private readonly config: AppConfig) {}

  async analyze(input: {
    mediaType: 'VIDEO' | 'PHOTO';
    frames: string[];
    original?: { path: string; mime: string; sizeBytes: number };
  }): Promise<VerifierResult> {
    const form = new FormData();
    form.set('media_type', input.mediaType);
    for (const frame of input.frames.slice(0, 16)) {
      // openAsBlob streams the file from disk instead of loading it into memory.
      form.append('frames', await openAsBlob(frame, { type: 'image/jpeg' }), path.basename(frame));
    }
    if (input.original && input.original.sizeBytes <= MAX_ORIGINAL_UPLOAD_BYTES) {
      const blob = await openAsBlob(input.original.path, { type: input.original.mime });
      form.set('original', blob, `original${path.extname(input.original.path)}`);
    }

    let res: Response;
    try {
      res = await fetch(`${this.config.verifierUrl.replace(/\/$/, '')}/v1/analyze`, {
        method: 'POST',
        headers: { 'X-Internal-Token': this.config.internalToken },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Connection refused, DNS failure, timeout...
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new VerifierUnavailableError(`request failed: ${cause ?? (err as Error).message}`, true);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new VerifierUnavailableError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status >= 500);
    }
    const body = (await res.json().catch(() => null)) as unknown;
    const parsed = parseResult(body);
    if (!parsed) {
      this.logger.warn(`Malformed verifier response: ${JSON.stringify(body).slice(0, 300)}`);
      throw new VerifierUnavailableError('malformed response', false);
    }
    return parsed;
  }
}

/** Validates the JSON shape by hand (no schema library in this project). Returns null if anything is off. */
export function parseResult(body: unknown): VerifierResult | null {
  if (!isObject(body) || !isObject(body.ai) || !isObject(body.c2pa) || !Array.isArray(body.phash)) return null;
  const { ai, c2pa } = body;
  if (typeof ai.available !== 'boolean') return null;
  const score = ai.score === null || ai.score === undefined ? null : Number(ai.score);
  if (score !== null && !(score >= 0 && score <= 1)) return null;
  const status = c2pa.status as C2paStatus;
  if (!C2PA_STATUSES.has(status)) return null;
  return {
    ai: {
      available: ai.available,
      score,
      model: typeof ai.model === 'string' ? ai.model : null,
      framesScored: Number.isInteger(ai.frames_scored) ? (ai.frames_scored as number) : 0,
      frameScores: Array.isArray(ai.frame_scores) ? ai.frame_scores.filter((n): n is number => typeof n === 'number') : [],
    },
    c2pa: {
      status,
      issuer: typeof c2pa.issuer === 'string' ? c2pa.issuer : null,
      claimGenerator: typeof c2pa.claim_generator === 'string' ? c2pa.claim_generator : null,
    },
    phashes: body.phash.filter((h): h is string => typeof h === 'string'),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
