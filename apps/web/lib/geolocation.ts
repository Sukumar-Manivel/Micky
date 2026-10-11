// Promise wrapper around the browser Geolocation API with plain-language errors.
// The browser shows its own permission prompt the first time; we only ask when the user taps
// a button, never on page load, because unexpected prompts get denied.

export interface Position {
  lat: number;
  lng: number;
  accuracy: number;
}

export function getCurrentPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('This browser cannot share your location. Move the pin on the map instead.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied. You can allow it in your browser settings, or move the pin on the map.'
            : err.code === err.TIMEOUT
              ? 'Finding your location took too long. Try again outdoors, or move the pin on the map.'
              : 'Your location is not available right now. Move the pin on the map instead.';
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}
