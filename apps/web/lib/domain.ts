// Helpers for the admin's newsroom check (app/admin/channels).

/**
 * A quick hint for the reviewer: does the email address belong to the website's domain?
 * (reporter@thehindu.co.in and https://www.thehindu.com do not match; that is worth a look.)
 */
export function domainMatch(email: string, website: string | null): 'match' | 'mismatch' | 'unknown' {
  if (!website) return 'unknown';
  const emailDomain = email.split('@')[1]?.toLowerCase();
  let host: string;
  try {
    host = new URL(website).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
  if (!emailDomain) return 'unknown';
  return emailDomain === host || emailDomain.endsWith(`.${host}`) || host.endsWith(`.${emailDomain}`) ? 'match' : 'mismatch';
}
