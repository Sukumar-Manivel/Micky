// Where to send the user after logging in, from `?next=`. docs/REVIEW.md M2.
//
// The old check ("starts with / but not //") was not enough, because browsers and the WHATWG
// URL parser are generous:
// - a backslash counts as a slash: `/\evil.example` is the protocol-relative `//evil.example`;
// - tabs and newlines are deleted: `/<TAB>/evil.example` becomes `//evil.example`;
// - dot segments collapse: `/..//evil.example` resolves to the path `//evil.example`.
// Next's router sends any URL on another origin to `location.replace`, so all of these left
// the site after a real login. The fix is to let the URL parser decide, then compare origins,
// and to check the value we return in the same way.

// Control characters (tab, newline, ...) and backslashes never belong in our own paths.
const SUSPICIOUS = /[\u0000-\u001f\u007f\\]/;

/**
 * Returns a same-origin path (`/path?query#hash`) that is safe to navigate to, or null.
 * `origin` is the page's own origin, normally `window.location.origin`.
 */
export function safeNext(next: string | null | undefined, origin: string): string | null {
  if (!next || next.length > 2048) return null;
  if (SUSPICIOUS.test(next)) return null;
  // Only paths. Absolute (`https://...`), scheme (`javascript:`) and protocol-relative (`//`) are out.
  if (!next.startsWith('/') || next.startsWith('//')) return null;

  let own: URL;
  let url: URL;
  try {
    own = new URL(origin);
    url = new URL(next, own);
  } catch {
    return null;
  }
  if (url.origin !== own.origin) return null;

  const path = `${url.pathname}${url.search}${url.hash}`;
  // The normalised path itself must not be protocol-relative (`/..//evil` -> `//evil`).
  if (path.startsWith('//') || new URL(path, own).origin !== own.origin) return null;
  // Sending a user back to /login after logging in would only loop.
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return null;
  return path;
}
