import { fitWithin, parseDate, parseIso6709, readExif, readVideoProbe, uprightSize } from './media-metadata.js';
import { parseResult } from './verifier.client.js';

describe('fitWithin', () => {
  it('scales 1080p landscape to 480p with even sides', () => {
    expect(fitWithin(1920, 1080, 854, 480)).toEqual({ width: 852, height: 480 });
  });

  it('keeps portrait clips portrait', () => {
    expect(fitWithin(1080, 1920, 854, 480)).toEqual({ width: 480, height: 852 });
  });

  it('never upscales, but still rounds to even', () => {
    expect(fitWithin(321, 241, 854, 480)).toEqual({ width: 320, height: 240 });
  });

  it('never returns 0 for extreme aspect ratios', () => {
    expect(fitWithin(10000, 3, 854, 480).height).toBe(2);
  });
});

describe('uprightSize', () => {
  it('swaps width and height for 90° and 270° rotations', () => {
    expect(uprightSize(1920, 1080, -90)).toEqual({ width: 1080, height: 1920 });
    expect(uprightSize(1920, 1080, 270)).toEqual({ width: 1080, height: 1920 });
    expect(uprightSize(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
    expect(uprightSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('parseIso6709', () => {
  it('parses phone video locations', () => {
    expect(parseIso6709('+10.0123+076.2673/')).toEqual({ latitude: 10.0123, longitude: 76.2673 });
    expect(parseIso6709('-33.8688+151.2093+012.500/')).toEqual({ latitude: -33.8688, longitude: 151.2093 });
  });

  it('rejects garbage, out-of-range values and (0, 0)', () => {
    expect(parseIso6709('hello')).toBeNull();
    expect(parseIso6709('+95.0+010.0/')).toBeNull();
    expect(parseIso6709('+00.0000+000.0000/')).toBeNull();
    expect(parseIso6709(undefined)).toBeNull();
  });
});

describe('parseDate', () => {
  it('rejects placeholder epochs and invalid dates', () => {
    expect(parseDate('1970-01-01T00:00:00Z')).toBeNull();
    expect(parseDate('1904-01-01T00:00:00Z')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('2026-10-11T08:00:00.000000Z')?.toISOString()).toBe('2026-10-11T08:00:00.000Z');
  });
});

describe('readVideoProbe', () => {
  it('reads an iPhone clip: rotation, location, device, capture time', () => {
    const result = readVideoProbe({
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '12.5',
        tags: {
          creation_time: '2026-10-11T08:00:00.000000Z',
          'com.apple.quicktime.location.ISO6709': '+09.9312+076.2673+005.000/',
          'com.apple.quicktime.make': 'Apple',
          'com.apple.quicktime.model': 'iPhone 15',
          'com.apple.quicktime.software': '18.0',
        },
      },
      streams: [
        { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    expect(result).toMatchObject({
      durationSec: 12.5,
      width: 1080,
      height: 1920,
      rotation: -90,
      videoCodec: 'hevc',
      audioCodec: 'aac',
      fileMetadata: {
        capturedAt: new Date('2026-10-11T08:00:00Z'),
        latitude: 9.9312,
        longitude: 76.2673,
        device: 'Apple iPhone 15',
        encoder: '18.0',
      },
    });
  });

  it('reports the re-encoder of an FFmpeg-made file and no capture data', () => {
    const result = readVideoProbe({
      format: { duration: '3.0', tags: { encoder: 'Lavf60.16.100' } },
      streams: [{ codec_type: 'video', width: 320, height: 240 }],
    });
    expect(result?.fileMetadata).toEqual({
      capturedAt: null,
      latitude: null,
      longitude: null,
      device: null,
      encoder: 'Lavf60.16.100',
    });
  });

  it('returns null when there is no video track', () => {
    expect(readVideoProbe({ streams: [{ codec_type: 'audio' }] })).toBeNull();
  });
});

describe('readExif', () => {
  it('reads GPS, device and an offset-aware capture time', () => {
    // exifr returns wall-clock time as a local Date; with the offset we get the true instant.
    const local = new Date(2026, 9, 11, 14, 5, 0);
    expect(
      readExif({
        DateTimeOriginal: local,
        OffsetTimeOriginal: '+05:30',
        latitude: 9.93,
        longitude: 76.26,
        Make: 'Google',
        Model: 'Pixel 9',
        Software: 'HDR+ 1.0',
      }),
    ).toEqual({
      capturedAt: new Date('2026-10-11T08:35:00Z'),
      latitude: 9.93,
      longitude: 76.26,
      device: 'Google Pixel 9',
      encoder: 'HDR+ 1.0',
    });
  });

  it('does not repeat the make when the model already contains it', () => {
    expect(readExif({ Make: 'samsung', Model: 'Samsung Galaxy S24' }).device).toBe('Samsung Galaxy S24');
  });

  it('handles missing EXIF', () => {
    expect(readExif(null)).toEqual({ capturedAt: null, latitude: null, longitude: null, device: null, encoder: null });
  });
});

describe('verifier parseResult', () => {
  const valid = {
    ai: { available: true, score: 0.12, model: 'm', frames_scored: 2, frame_scores: [0.1, 0.14] },
    c2pa: { status: 'absent', issuer: null, claim_generator: null },
    phash: ['a1b2c3d4e5f60718', 'a1b2c3d4e5f60719'],
  };

  it('accepts the documented shape', () => {
    expect(parseResult(valid)).toEqual({
      ai: { available: true, score: 0.12, model: 'm', framesScored: 2, frameScores: [0.1, 0.14] },
      c2pa: { status: 'absent', issuer: null, claimGenerator: null },
      phashes: ['a1b2c3d4e5f60718', 'a1b2c3d4e5f60719'],
    });
  });

  it('accepts an unavailable detector (score null)', () => {
    expect(parseResult({ ...valid, ai: { available: false, score: null, model: null, frames_scored: 0, frame_scores: [] } })?.ai)
      .toMatchObject({ available: false, score: null });
  });

  it.each([
    ['not an object', 'oops'],
    ['a score out of range', { ...valid, ai: { ...valid.ai, score: 1.5 } }],
    ['an unknown C2PA status', { ...valid, c2pa: { status: 'great' } }],
    ['no phash list', { ai: valid.ai, c2pa: valid.c2pa }],
  ])('rejects %s', (_name, body) => {
    expect(parseResult(body)).toBeNull();
  });
});
