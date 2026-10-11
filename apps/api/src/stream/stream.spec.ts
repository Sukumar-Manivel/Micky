import { decidePreviewAccess, type PreviewViewer } from './preview-access.js';
import { deliveryFileName, downloadFileName } from '../common/views.js';
import { formatIst, SEGMENT_NAME } from './stream.service.js';

describe('decidePreviewAccess', () => {
  const owner = 'owner-id';
  const viewer = (role: PreviewViewer['role'], extra: Partial<PreviewViewer> = {}): PreviewViewer => ({
    id: 'viewer-id',
    role,
    channelStatus: role === 'CHANNEL' ? 'APPROVED' : null,
    ...extra,
  });

  it('admins can preview anything', () => {
    for (const status of ['PROCESSING', 'IN_REVIEW', 'REJECTED', 'REMOVED'] as const) {
      expect(decidePreviewAccess(viewer('ADMIN'), { uploaderId: owner, status })).toBe('ok');
    }
  });

  it('approved channels can preview APPROVED media only', () => {
    expect(decidePreviewAccess(viewer('CHANNEL'), { uploaderId: owner, status: 'APPROVED' })).toBe('ok');
    expect(decidePreviewAccess(viewer('CHANNEL'), { uploaderId: owner, status: 'IN_REVIEW' })).toBe('not-found');
    expect(
      decidePreviewAccess(viewer('CHANNEL', { channelStatus: 'PENDING' }), { uploaderId: owner, status: 'APPROVED' }),
    ).toBe('forbidden');
  });

  it('closes previews for other channels once an exclusive licence is sold', () => {
    const sold = { uploaderId: owner, status: 'APPROVED' as const, exclusiveSold: true };
    expect(decidePreviewAccess(viewer('CHANNEL'), sold)).toBe('sold');
    expect(decidePreviewAccess(viewer('CHANNEL', { holdsExclusive: true }), sold)).toBe('ok');
    expect(decidePreviewAccess(viewer('UPLOADER', { id: owner }), sold)).toBe('ok');
    expect(decidePreviewAccess(viewer('ADMIN'), sold)).toBe('ok');
  });

  it('uploaders can preview their own media unless it was removed', () => {
    expect(decidePreviewAccess(viewer('UPLOADER', { id: owner }), { uploaderId: owner, status: 'IN_REVIEW' })).toBe(
      'ok',
    );
    expect(decidePreviewAccess(viewer('UPLOADER', { id: owner }), { uploaderId: owner, status: 'REMOVED' })).toBe(
      'not-found',
    );
    expect(decidePreviewAccess(viewer('UPLOADER'), { uploaderId: owner, status: 'APPROVED' })).toBe('not-found');
  });
});

describe('SEGMENT_NAME', () => {
  it('accepts only seg_NNN.ts names', () => {
    for (const ok of ['seg_000.ts', 'seg_12345.ts']) expect(SEGMENT_NAME.test(ok)).toBe(true);
    for (const bad of ['seg_00.ts', 'seg_123456.ts', '../seg_000.ts', 'seg_000.ts/..', 'key.bin', 'seg_000.ts\n']) {
      expect(SEGMENT_NAME.test(bad)).toBe(false);
    }
  });
});

describe('formatIst', () => {
  it('formats in Indian Standard Time (UTC+5:30)', () => {
    expect(formatIst(new Date('2026-10-10T20:45:00Z'))).toBe('2026-10-11 02:15 IST');
  });
});

describe('downloadFileName / deliveryFileName (one name for JSON and Content-Disposition)', () => {
  const row = (title: string, originalKey: string, mimeType = 'video/mp4') => ({ title, originalKey, mimeType });
  it('keeps only safe characters and the delivered file\'s extension', () => {
    expect(deliveryFileName(row('Fire at "Marine Drive" / Kochi!', 'originals/x/source.mp4'))).toBe(
      'Fire-at-Marine-Drive-Kochi.mp4',
    );
    expect(deliveryFileName(row('../../etc/passwd', 'originals/x/source.MOV', 'video/quicktime'))).toBe('etcpasswd.mov');
    expect(deliveryFileName(row('!!!', 'originals/x/source.jpg', 'image/jpeg'))).toBe('firstframe-media.jpg');
  });

  it('names HEIC photos .jpg, because they are delivered as JPEG', () => {
    expect(deliveryFileName(row('Flood at the bridge', 'originals/x/source.heic', 'image/heic'))).toBe(
      'Flood-at-the-bridge.jpg',
    );
  });

  it('never takes an extension it does not trust', () => {
    expect(downloadFileName('Clip', '.exe/../x')).toBe('Clip');
  });
});
