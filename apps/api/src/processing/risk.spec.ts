import { assessRisk, type RiskInput } from './risk.js';

const CLAIMED_AT = new Date('2026-10-09T10:00:00Z');

/** A "clean" upload: verifier up, low AI score, metadata matches the claim. */
function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    verifierAvailable: true,
    ai: { available: true, score: 0.1, model: 'test-model' },
    c2pa: { status: 'absent', issuer: null },
    duplicateOfId: null,
    claimed: { capturedAt: CLAIMED_AT, latitude: 11.0168, longitude: 76.9558 },
    fileMetadata: {
      capturedAt: new Date('2026-10-09T10:05:00Z'),
      latitude: 11.02,
      longitude: 76.96,
      device: 'Pixel 9',
      encoder: null,
    },
    ...overrides,
  };
}

const codes = (r: ReturnType<typeof assessRisk>) => r.signals.map((s) => s.code);

describe('assessRisk', () => {
  it('rates a clean upload LOW', () => {
    const result = assessRisk(input());
    expect(result.riskLevel).toBe('LOW');
    expect(codes(result)).toEqual(['AI_SCORE_LOW', 'NO_AI_LABEL', 'C2PA_ABSENT']);
  });

  it('rates a high AI score HIGH and a medium one MEDIUM', () => {
    const high = assessRisk(input({ ai: { available: true, score: 0.9, model: 'm' } }));
    expect(high.riskLevel).toBe('HIGH');
    expect(high.signals.find((s) => s.code === 'AI_SCORE_HIGH')?.level).toBe('danger');

    expect(assessRisk(input({ ai: { available: true, score: 0.85, model: 'm' } })).riskLevel).toBe('HIGH');
    const medium = assessRisk(input({ ai: { available: true, score: 0.5, model: 'm' } }));
    expect(medium.riskLevel).toBe('MEDIUM');
    expect(codes(medium)).toContain('AI_SCORE_MEDIUM');
  });

  it('lowers the risk one step for valid C2PA', () => {
    const result = assessRisk(
      input({ ai: { available: true, score: 0.6, model: 'm' }, c2pa: { status: 'valid', issuer: 'Google' } }),
    );
    expect(result.riskLevel).toBe('LOW');
    const c2pa = result.signals.find((s) => s.code === 'C2PA_VALID');
    expect(c2pa?.level).toBe('positive');
    expect(c2pa?.message).toContain('Google');
  });

  it('does not let valid C2PA lower the risk of a duplicate', () => {
    const result = assessRisk(input({ c2pa: { status: 'valid', issuer: null }, duplicateOfId: 'abc' }));
    expect(result.riskLevel).toBe('HIGH');
    expect(codes(result)).toContain('DUPLICATE');
  });

  it('treats invalid C2PA as danger', () => {
    const result = assessRisk(input({ c2pa: { status: 'invalid', issuer: null } }));
    expect(result.riskLevel).toBe('HIGH');
    expect(result.signals.find((s) => s.code === 'C2PA_INVALID')?.level).toBe('danger');
  });

  it('treats missing metadata as neutral information', () => {
    const result = assessRisk(
      input({ fileMetadata: { capturedAt: null, latitude: null, longitude: null, device: null, encoder: null } }),
    );
    expect(result.riskLevel).toBe('LOW');
    expect(result.signals.find((s) => s.code === 'NO_METADATA')?.level).toBe('info');
  });

  it('warns when the capture time differs from the claim by more than 24 hours', () => {
    const meta = input().fileMetadata;
    const ok = assessRisk(input({ fileMetadata: { ...meta, capturedAt: new Date('2026-10-10T09:00:00Z') } }));
    expect(codes(ok)).not.toContain('CAPTURE_TIME_MISMATCH');

    const bad = assessRisk(input({ fileMetadata: { ...meta, capturedAt: new Date('2026-10-01T10:00:00Z') } }));
    expect(bad.riskLevel).toBe('MEDIUM');
    expect(bad.signals.find((s) => s.code === 'CAPTURE_TIME_MISMATCH')?.message).toContain('8 days');
  });

  it('warns when the GPS location is more than 25 km from the claim', () => {
    const meta = input().fileMetadata;
    // Chennai is about 400 km from Coimbatore.
    const result = assessRisk(input({ fileMetadata: { ...meta, latitude: 13.0827, longitude: 80.2707 } }));
    expect(result.riskLevel).toBe('MEDIUM');
    expect(codes(result)).toContain('LOCATION_MISMATCH');
  });

  it('notes re-encoded files without raising the risk', () => {
    const meta = input().fileMetadata;
    const result = assessRisk(input({ fileMetadata: { ...meta, encoder: 'Lavf60.16.100' } }));
    expect(result.riskLevel).toBe('LOW');
    expect(result.signals.find((s) => s.code === 'REENCODED')?.level).toBe('info');
  });

  it('asks for manual review when the verifier is unreachable', () => {
    const result = assessRisk(
      input({
        verifierAvailable: false,
        ai: { available: false, score: null, model: null },
        c2pa: { status: 'unsupported', issuer: null },
      }),
    );
    expect(result.riskLevel).toBe('MEDIUM');
    expect(codes(result)).toEqual(['VERIFIER_UNAVAILABLE', 'NO_AI_LABEL']);
  });

  it('writes every message in plain English', () => {
    const result = assessRisk(
      input({
        ai: { available: true, score: 0.99, model: 'm' },
        c2pa: { status: 'invalid', issuer: null },
        duplicateOfId: 'x',
      }),
    );
    for (const s of result.signals) expect(s.message).toMatch(/^[A-Z].*\.$/);
  });
  describe('AI-generator labels in the file', () => {
    const label = { tool: 'Midjourney', kind: 'generated' as const, evidence: 'software midjourney v7' };

    it('rates an upload HIGH when the file says an AI tool made it, even with a low model score', () => {
      const result = assessRisk(input({ aiSignatures: [label] }));
      expect(result.riskLevel).toBe('HIGH');
      expect(result.signals.find((s) => s.code === 'AI_SIGNATURE')?.message).toContain('Midjourney');
      expect(codes(result)).not.toContain('NO_AI_LABEL');
    });

    it('rates a real capture edited with generative AI HIGH, with its own message', () => {
      const result = assessRisk(
        input({ aiSignatures: [{ tool: 'a generative AI editing tool', kind: 'edited', evidence: 'compositewithtrainedalgorithmicmedia' }] }),
      );
      expect(result.riskLevel).toBe('HIGH');
      expect(codes(result)).toContain('AI_EDIT_SIGNATURE');
    });

    it('does not let valid Content Credentials lower the risk when they come with an AI label', () => {
      const result = assessRisk(input({ c2pa: { status: 'valid', issuer: 'OpenAI' }, aiSignatures: [label] }));
      expect(result.riskLevel).toBe('HIGH');
    });
  });
});
