import { ordersApi } from './api';

/**
 * Downloads a purchased file (docs/REVIEW.md M3):
 * 1. Asks the API for a link, with the buyer's session (`GET /orders/:id/download` needs the
 *    access token, so only the buyer can get one).
 * 2. Navigates to it straight away. The link works **once**, and only for about 2 minutes, so
 *    it cannot be reused or forwarded; every click asks for a fresh one.
 *
 * The API responds with `Content-Disposition: attachment`, so the browser saves the file
 * (streamed to disk, never held in memory) and the current page stays where it is. The file
 * is the delivery copy without identifying metadata; its SHA-256 is in the
 * `X-Content-SHA256` header and on the media page.
 */
export async function downloadOriginal(orderId: string): Promise<void> {
  const { url } = await ordersApi.download(orderId);
  window.location.assign(url);
}
