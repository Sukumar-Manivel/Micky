import { createHmac } from 'node:crypto';
import { MockProvider } from './mock.provider.js';
import { hmacSha256Matches } from './payment-provider.js';
import { RazorpayProvider } from './razorpay.provider.js';

// Expected signatures below were computed independently with openssl, e.g.
//   printf 'order_IEIaMR65cu6nz3|pay_IH4NVgf4Dreq1l' | openssl dgst -sha256 -hmac 'rzp_test_secret_123'
// so the test does not just repeat the implementation.
const KEY_SECRET = 'rzp_test_secret_123';
const WEBHOOK_SECRET = 'whsec_test';
const ORDER_ID = 'order_IEIaMR65cu6nz3';
const PAYMENT_ID = 'pay_IH4NVgf4Dreq1l';
const PAYMENT_SIGNATURE =
  '2274281c39c38e4fc42c4fbdee8293ed9b155386c298260659db98fe8e87372b';
const WEBHOOK_BODY = '{"event":"payment.captured"}';
const WEBHOOK_SIGNATURE =
  '4f463a57dd128675850163391f0311888616d57bccca75c774c9cdb28134f851';

describe('Razorpay signature verification', () => {
  const provider = new RazorpayProvider({
    keyId: 'rzp_test_key',
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
  });

  it('accepts the payment signature HMAC_SHA256(order_id|payment_id, key_secret)', () => {
    expect(
      provider.verifyPaymentSignature(ORDER_ID, PAYMENT_ID, PAYMENT_SIGNATURE),
    ).toBe(true);
  });

  it('rejects the signature when used with a different order id (replay from another order)', () => {
    expect(
      provider.verifyPaymentSignature(
        'order_SOMETHINGELSE',
        PAYMENT_ID,
        PAYMENT_SIGNATURE,
      ),
    ).toBe(false);
  });

  it('rejects a tampered, truncated or empty signature without throwing', () => {
    const tampered =
      PAYMENT_SIGNATURE.slice(0, -1) +
      (PAYMENT_SIGNATURE.endsWith('a') ? 'b' : 'a');
    expect(
      provider.verifyPaymentSignature(ORDER_ID, PAYMENT_ID, tampered),
    ).toBe(false);
    expect(
      provider.verifyPaymentSignature(
        ORDER_ID,
        PAYMENT_ID,
        PAYMENT_SIGNATURE.slice(0, 10),
      ),
    ).toBe(false);
    expect(provider.verifyPaymentSignature(ORDER_ID, PAYMENT_ID, '')).toBe(
      false,
    );
  });

  it('rejects a payment signature made with the webhook secret instead of the key secret', () => {
    const wrongKey = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${ORDER_ID}|${PAYMENT_ID}`)
      .digest('hex');
    expect(
      provider.verifyPaymentSignature(ORDER_ID, PAYMENT_ID, wrongKey),
    ).toBe(false);
  });

  it('accepts the webhook signature HMAC_SHA256(raw body, webhook_secret)', () => {
    expect(
      provider.verifyWebhookSignature(
        Buffer.from(WEBHOOK_BODY),
        WEBHOOK_SIGNATURE,
      ),
    ).toBe(true);
  });

  it('rejects a webhook whose body changed by even one space', () => {
    // This is why the raw bytes must be used: JSON.stringify(JSON.parse(body)) may differ.
    expect(
      provider.verifyWebhookSignature(
        Buffer.from('{"event": "payment.captured"}'),
        WEBHOOK_SIGNATURE,
      ),
    ).toBe(false);
  });

  it('hmacSha256Matches compares hex digests of the given payload', () => {
    expect(
      hmacSha256Matches(WEBHOOK_SECRET, WEBHOOK_BODY, WEBHOOK_SIGNATURE),
    ).toBe(true);
    expect(
      hmacSha256Matches(
        WEBHOOK_SECRET,
        WEBHOOK_BODY,
        WEBHOOK_SIGNATURE.toUpperCase(),
      ),
    ).toBe(false);
  });
});

describe('MockProvider', () => {
  const provider = new MockProvider();

  it('creates mock_order_<uuid> ids', async () => {
    const { providerOrderId } = await provider.createOrder({
      amountPaise: 100,
      receipt: 'r',
      notes: {},
    });
    expect(providerOrderId).toMatch(/^mock_order_[0-9a-f-]{36}$/);
  });

  it('never accepts a signature, so mock orders cannot be paid through the Razorpay routes', () => {
    expect(provider.verifyPaymentSignature()).toBe(false);
    expect(provider.verifyWebhookSignature()).toBe(false);
  });
});
