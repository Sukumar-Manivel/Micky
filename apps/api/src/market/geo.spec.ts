import { distanceKm } from '../common/views.js';
import { boundingBox, escapeLike } from './geo.js';

describe('boundingBox', () => {
  it('contains every point of the circle (checked on the circle edge in 36 directions)', () => {
    const center = { lat: 9.9312, lng: 76.2673 };
    const radius = 50;
    const box = boundingBox(center.lat, center.lng, radius);
    for (let deg = 0; deg < 360; deg += 10) {
      // Walk `radius` km from the centre in direction `deg` (destination-point formula).
      const R = 6371;
      const b = (deg * Math.PI) / 180;
      const φ1 = (center.lat * Math.PI) / 180;
      const λ1 = (center.lng * Math.PI) / 180;
      const δ = radius / R;
      const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(b));
      const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
      const lat = (φ2 * 180) / Math.PI;
      const lng = (λ2 * 180) / Math.PI;
      expect(distanceKm(center.lat, center.lng, lat, lng)).toBeCloseTo(radius, 3);
      expect(lat).toBeGreaterThanOrEqual(box.minLat - 1e-9);
      expect(lat).toBeLessThanOrEqual(box.maxLat + 1e-9);
      expect(lng).toBeGreaterThanOrEqual(box.minLng! - 1e-9);
      expect(lng).toBeLessThanOrEqual(box.maxLng! + 1e-9);
    }
  });

  it('drops the longitude range near the poles and across the antimeridian', () => {
    expect(boundingBox(89.9, 0, 50).minLng).toBeUndefined();
    expect(boundingBox(0, 179.9, 50).minLng).toBeUndefined();
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('100%_sure\\')).toBe('100\\%\\_sure\\\\');
    expect(escapeLike('plain text')).toBe('plain text');
  });
});

describe('publicCoordinate (review M8)', () => {
  it('rounds published coordinates to 3 decimals (about 100 m)', async () => {
    const { publicCoordinate } = await import('../common/views.js');
    expect(publicCoordinate(11.016844)).toBe(11.017);
    expect(publicCoordinate(76.955832)).toBe(76.956);
    expect(publicCoordinate(-0.0004)).toBe(-0);
  });
});
