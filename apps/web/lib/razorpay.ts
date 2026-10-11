// Razorpay Standard Checkout, from the browser's side.
//
// Flow:
// 1. Our API creates a Razorpay order (POST /orders) and returns its id and our public key id.
// 2. We load Razorpay's script and open its hosted checkout. Card/UPI details are typed into
//    Razorpay's own iframe, never into our page, which keeps us out of PCI scope.
// 3. On success Razorpay gives us payment_id + order_id + signature. We send them to our API
//    (POST /orders/:id/verify), which recomputes HMAC_SHA256(order_id|payment_id, secret)
//    with the secret only the server knows. The browser's "success" is never trusted alone;
//    the webhook is a second, server-to-server confirmation.

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

export interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (res: RazorpaySuccess) => void;
  prefill?: { email?: string; name?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  on: (event: 'payment.failed', cb: (res: { error: { description?: string } }) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load Razorpay. Check your connection or ad blocker and try again.'));
      };
      document.body.appendChild(s);
    });
  }
  return scriptPromise;
}

export class PaymentCancelled extends Error {
  constructor() {
    super('Payment was cancelled.');
    this.name = 'PaymentCancelled';
  }
}

/** Opens Razorpay Checkout. Resolves with the signed result, rejects on failure or close. */
export async function openRazorpay(opts: {
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  description: string;
  prefill?: { email?: string; name?: string };
}): Promise<RazorpaySuccess> {
  await loadScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error('Razorpay did not load.');
  return new Promise((resolve, reject) => {
    const rzp = new Razorpay({
      key: opts.keyId,
      order_id: opts.orderId,
      amount: opts.amount,
      currency: opts.currency,
      name: 'Micky',
      description: opts.description,
      prefill: opts.prefill,
      theme: { color: '#13212c' },
      handler: resolve,
      modal: { ondismiss: () => reject(new PaymentCancelled()) },
    });
    rzp.on('payment.failed', (res) => reject(new Error(res.error.description ?? 'The payment failed.')));
    rzp.open();
  });
}
