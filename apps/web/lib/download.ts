import { ordersApi } from './api';

/**
 * Asks the API for a fresh signed download link (valid 15 minutes) and navigates to it.
 * The API responds with `Content-Disposition: attachment`, so the browser saves the file
 * and the current page stays where it is.
 */
export async function downloadOriginal(orderId: string): Promise<void> {
  const { url } = await ordersApi.download(orderId);
  window.location.assign(url);
}
