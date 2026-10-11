import { deliveryExt, deliveryKey, deliveryMimeType, readDeliveryInfo } from './delivery.js';
import { HEAVY_MARK, NORMAL_MARK, videoPreviewPlan, viewerMarkText, viewerTag } from './preview-plan.js';

describe('videoPreviewPlan', () => {
  it('shows at most 40% of a clip, and never more than PREVIEW_MAX_SECONDS', () => {
    expect(videoPreviewPlan(12, 30).seconds).toBe(4.8);
    expect(videoPreviewPlan(60, 30).seconds).toBe(24);
    expect(videoPreviewPlan(600, 30).seconds).toBe(30);
    expect(videoPreviewPlan(2, 30).seconds).toBe(1); // at least 1 s
  });

  it('never gives away a whole short clip', () => {
    for (const d of [1.5, 3, 6, 12, 29, 31, 74.9]) expect(videoPreviewPlan(d, 30).seconds).toBeLessThan(d);
  });

  it('uses 360p and heavier marks for clips under 30 s, 480p for longer ones', () => {
    expect(videoPreviewPlan(12, 30)).toMatchObject({ size: { long: 640, short: 360 }, mark: HEAVY_MARK });
    expect(videoPreviewPlan(45, 30)).toMatchObject({ size: { long: 854, short: 480 }, mark: NORMAL_MARK });
  });

  it('falls back to a short, small preview when the duration is unknown', () => {
    expect(videoPreviewPlan(null, 30)).toMatchObject({ seconds: 10, size: { long: 640, short: 360 } });
  });
});

describe('viewer marks', () => {
  const id = '1a2b3c4d-0000-4000-8000-000000000000';
  it('uses the first 8 hex digits of the user id', () => {
    expect(viewerTag(id)).toBe('1A2B3C4D');
  });
  it('keeps the organisation readable and drops characters that could break the filter', () => {
    expect(viewerMarkText('Kerala News 24', id)).toBe('KERALA NEWS 24 · 1A2B3C4D');
    expect(viewerMarkText("T'puram:Times\n%{pts}", id)).toBe("T'PURAMTIMESPTS · 1A2B3C4D");
    expect(viewerMarkText('***', id)).toBe('NEWSROOM · 1A2B3C4D');
  });
});

describe('delivery copy naming', () => {
  const row = (mimeType: string, ext: string) => ({ id: 'm1', originalKey: `originals/m1/source${ext}`, mimeType });
  it('sits next to the original, with HEIC delivered as JPEG', () => {
    expect(deliveryKey(row('video/mp4', '.mp4'))).toBe('originals/m1/delivery.mp4');
    expect(deliveryKey(row('image/heic', '.heic'))).toBe('originals/m1/delivery.jpg');
    expect(deliveryMimeType('image/heic')).toBe('image/jpeg');
    expect(deliveryExt(row('video/quicktime', '.MOV'))).toBe('.mov');
  });
  it('reads only well-formed delivery facts', () => {
    const info = { key: 'k', sha256: 'a'.repeat(64), sizeBytes: 3, mimeType: 'video/mp4', createdAt: 'x' };
    expect(readDeliveryInfo({ delivery: info })).toEqual(info);
    expect(readDeliveryInfo({ delivery: { ...info, sha256: 'nope' } })).toBeNull();
    expect(readDeliveryInfo({})).toBeNull();
    expect(readDeliveryInfo(null)).toBeNull();
  });
});
