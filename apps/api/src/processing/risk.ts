// Turns the raw evidence about an upload into human-readable signals and a
// risk level for the admin review queue.
//
// This is a pure function (no database, no I/O), so every rule can be unit
// tested with plain objects. The risk level is advice for a human reviewer,
// never an automatic verdict: AI detectors are unreliable on new generators
// (see docs/RESEARCH.md), so an admin always makes the final decision.
import type { RiskLevel, VerificationSignal } from '../db/schema.js';
import { distanceKm } from '../common/views.js';
import type { AiSignature } from './ai-signatures.js';

export type C2paStatus = 'valid' | 'invalid' | 'absent' | 'error' | 'unsupported';

export const AI_HIGH_THRESHOLD = 0.85;
export const AI_MEDIUM_THRESHOLD = 0.5;
export const MAX_TIME_MISMATCH_HOURS = 24;
export const MAX_GPS_MISMATCH_KM = 25;

export interface RiskInput {
  /** False when the verifier service could not be reached at all. */
  verifierAvailable: boolean;
  ai: { available: boolean; score: number | null; model: string | null };
  c2pa: { status: C2paStatus; issuer: string | null };
  duplicateOfId: string | null;
  /** What the uploader told us. */
  claimed: { capturedAt: Date; latitude: number; longitude: number };
  /** What the file itself says (ffprobe tags or EXIF). Null fields = not present. */
  fileMetadata: {
    capturedAt: Date | null;
    latitude: number | null;
    longitude: number | null;
    device: string | null;
    encoder: string | null;
  };
  /** AI-generator labels found inside the file (see ai-signatures.ts). */
  aiSignatures?: AiSignature[];
}

export interface RiskResult {
  riskLevel: RiskLevel;
  signals: VerificationSignal[];
}

const LEVEL_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

/** Which risk level a single signal pushes the upload to (at least). */
const RISK_OF: Record<VerificationSignal['level'], RiskLevel> = {
  danger: 'HIGH',
  warning: 'MEDIUM',
  info: 'LOW',
  positive: 'LOW',
};

// Encoders that mean the file was re-encoded by software rather than coming
// straight from a camera (FFmpeg's "Lavf", HandBrake, editing apps...).
const REENCODER_PATTERN = /\b(lavf|lavc|handbrake|premiere|davinci|capcut|inshot|kinemaster|adobe)/i;

export function assessRisk(input: RiskInput): RiskResult {
  const signals: VerificationSignal[] = [];
  const add = (code: string, level: VerificationSignal['level'], message: string) =>
    signals.push({ code, level, message });

  // ---- 1. AI-likelihood score ----
  if (!input.verifierAvailable) {
    add(
      'VERIFIER_UNAVAILABLE',
      'warning',
      'The verification service could not be reached, so no AI or provenance check was done. Review this upload manually.',
    );
  } else if (!input.ai.available || input.ai.score === null) {
    add('AI_CHECK_UNAVAILABLE', 'warning', 'The AI-generation detector was not available for this upload.');
  } else {
    const percent = Math.round(input.ai.score * 100);
    if (input.ai.score >= AI_HIGH_THRESHOLD) {
      add('AI_SCORE_HIGH', 'danger', `The AI detector rates this ${percent}% likely to be AI-generated.`);
    } else if (input.ai.score >= AI_MEDIUM_THRESHOLD) {
      add('AI_SCORE_MEDIUM', 'warning', `The AI detector rates this ${percent}% likely to be AI-generated.`);
    } else {
      add(
        'AI_SCORE_LOW',
        'info',
        `The AI detector rates this ${percent}% likely to be AI-generated. Detectors miss many modern fakes, so this is not proof it is real.`,
      );
    }
  }

  // ---- 1b. Labels the AI tools write into their own files ----
  // The strongest evidence we have: a camera never writes "Midjourney" or
  // "trainedAlgorithmicMedia". Absence proves nothing (labels are easy to strip).
  const aiSignatures = input.aiSignatures ?? [];
  for (const sig of aiSignatures) {
    if (sig.kind === 'edited') {
      add(
        'AI_EDIT_SIGNATURE',
        'danger',
        `The file is labelled as a real capture changed with ${sig.tool}: "${sig.evidence}". Parts of the picture may be made up.`,
      );
    } else {
      add(
        'AI_SIGNATURE',
        'danger',
        `The file is labelled as made by ${sig.tool}: "${sig.evidence}" was found in its metadata. Cameras never write this, so treat it as AI-generated.`,
      );
    }
  }
  if (aiSignatures.length === 0) {
    add(
      'NO_AI_LABEL',
      'info',
      'No AI-generator labels were found in the file. Labels are easy to remove, so this alone does not prove it is real.',
    );
  }

  // ---- 2. Content Credentials (C2PA) ----
  const c2paValid = input.c2pa.status === 'valid';
  switch (input.c2pa.status) {
    case 'valid':
      add(
        'C2PA_VALID',
        'positive',
        `The file carries valid Content Credentials${input.c2pa.issuer ? ` signed by ${input.c2pa.issuer}` : ''}.`,
      );
      break;
    case 'invalid':
      add(
        'C2PA_INVALID',
        'danger',
        'The file has Content Credentials, but they do not match the content. It may have been edited after capture.',
      );
      break;
    case 'absent':
      add('C2PA_ABSENT', 'info', 'No Content Credentials. This is normal for most phones and is not suspicious by itself.');
      break;
    case 'error':
      add('C2PA_ERROR', 'info', 'The Content Credentials in this file could not be read.');
      break;
    case 'unsupported':
      break; // nothing to say: the format or the service could not check it
  }

  // ---- 3. Duplicates ----
  if (input.duplicateOfId) {
    add(
      'DUPLICATE',
      'danger',
      `This looks like a copy of an earlier upload (${input.duplicateOfId}). Check it is not a re-upload of someone else's footage.`,
    );
  }

  // ---- 4. Metadata compared with what the uploader claimed ----
  const meta = input.fileMetadata;
  const hasCaptureMetadata = meta.capturedAt !== null || meta.latitude !== null || meta.device !== null;
  if (!hasCaptureMetadata) {
    add(
      'NO_METADATA',
      'info',
      'The file has no capture time, location or device information. Messaging apps remove these, so this is common.',
    );
  }

  if (meta.capturedAt) {
    const diffHours = Math.abs(meta.capturedAt.getTime() - input.claimed.capturedAt.getTime()) / 3_600_000;
    if (diffHours > MAX_TIME_MISMATCH_HOURS) {
      add(
        'CAPTURE_TIME_MISMATCH',
        'warning',
        `The file says it was recorded at ${meta.capturedAt.toISOString()}, ${formatHours(diffHours)} away from the time the uploader gave.`,
      );
    }
  }

  if (meta.latitude !== null && meta.longitude !== null) {
    const km = distanceKm(meta.latitude, meta.longitude, input.claimed.latitude, input.claimed.longitude);
    if (km > MAX_GPS_MISMATCH_KM) {
      add(
        'LOCATION_MISMATCH',
        'warning',
        `The GPS location in the file is ${Math.round(km)} km from the location the uploader gave.`,
      );
    }
  }

  if (meta.encoder && REENCODER_PATTERN.test(meta.encoder)) {
    add(
      'REENCODED',
      'info',
      `The file was re-encoded by software ("${meta.encoder}"), so it is probably not the camera original.`,
    );
  }

  // ---- 5. Combine: the most serious signal sets the level ----
  let level = signals.reduce<RiskLevel>((worst, s) => maxLevel(worst, RISK_OF[s.level]), 'LOW');
  // Valid provenance is strong evidence, so it lowers the risk one step,
  // except for duplicates (a signed file can still be someone else's) and AI labels
  // (OpenAI and Adobe sign their AI images: valid credentials then confirm the label).
  if (c2paValid && !input.duplicateOfId && aiSignatures.length === 0) level = lowerLevel(level);

  return { riskLevel: level, signals };
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

function lowerLevel(level: RiskLevel): RiskLevel {
  return LEVEL_ORDER[Math.max(0, LEVEL_ORDER.indexOf(level) - 1)];
}

function formatHours(hours: number): string {
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`;
}
