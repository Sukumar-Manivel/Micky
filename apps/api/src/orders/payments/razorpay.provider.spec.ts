import type { AppConfig } from '../../config/app-config.js';
import {
  checkoutTtlMs,
  saleCreditHoldMs,
  upiCoolingOffMs,
} from '../../earnings/money-policy.js';
import { MockProvider } from './mock.provider.js';
import { RazorpayProvider } from './razorpay.provider.js';

/** The Razorpay SDK client, replaced by fakes: these tests never touch the network. */
interface FakeClient {
  orders: { create: ReturnType<typeof vi.fn> };
  payments: {
    fetch: ReturnType<typeof vi.fn>;
    refund: ReturnType<typeof vi.fn>;
    fetchMultipleRefund: ReturnType<typeof vi.fn>;
  };
}

function providerWithFakeClient() {
  const provider = new RazorpayProvider({
    keyId: 'rzp_test_key',
    keySecret: 'secret',
    webhookSecret: 'whsec',
  });
  const client: FakeClient = {
    orders: { create: vi.fn().mockResolvedValue({ id: 'order_Fake0001' }) },
    payments: {
      fetch: vi.fn(),
      refund: vi.fn(),
      fetchMultipleRefund: vi
        .fn()
        .mockResolvedValue({ entity: 'collection', count: 0, items: [] }),
    },
  };
  (provider as unknown as { client: FakeClient }).client = client;
  return { provider, client };
}

const refundInput = {
  paymentId: 'pay_Abc',
  amountPaise: 150_000,
  receipt: '7d8a7a43-6f33-4a3c-9a52-1f0d0e3f3b11',
  notes: { orderId: 'o1' },
};

describe('RazorpayProvider (fake SDK client)', () => {
  it('creates orders with automatic capture (M5)', async () => {
    const { provider, client } = providerWithFakeClient();
    await expect(
      provider.createOrder({
        amountPaise: 500_000,
        receipt: 'r1',
        notes: { a: 'b' },
      }),
    ).resolves.toEqual({ providerOrderId: 'order_Fake0001' });
    expect(client.orders.create).toHaveBeenCalledWith({
      amount: 500_000,
      currency: 'INR',
      receipt: 'r1',
      notes: { a: 'b' },
      payment_capture: true,
    });
  });

  it('maps a fetched payment', async () => {
    const { provider, client } = providerWithFakeClient();
    client.payments.fetch.mockResolvedValue({
      id: 'pay_Abc',
      order_id: 'order_X',
      status: 'captured',
      amount: 150_000,
      currency: 'INR',
      created_at: 1_790_000_000,
    });
    await expect(provider.fetchPayment('pay_Abc')).resolves.toEqual({
      id: 'pay_Abc',
      orderId: 'order_X',
      status: 'captured',
      amount: 150_000,
      currency: 'INR',
      createdAt: new Date(1_790_000_000_000),
    });
  });

  it('refunds in full with our receipt when there is no earlier refund', async () => {
    const { provider, client } = providerWithFakeClient();
    client.payments.refund.mockResolvedValue({
      id: 'rfnd_New',
      status: 'pending',
    });
    await expect(provider.refund(refundInput)).resolves.toEqual({
      refundId: 'rfnd_New',
      status: 'pending',
    });
    expect(client.payments.refund).toHaveBeenCalledWith('pay_Abc', {
      amount: 150_000,
      speed: 'normal',
      receipt: refundInput.receipt,
      notes: { orderId: 'o1' },
    });
  });

  it('is idempotent: a retried job finds the refund it created before instead of refunding twice', async () => {
    const { provider, client } = providerWithFakeClient();
    client.payments.fetchMultipleRefund.mockResolvedValue({
      entity: 'collection',
      count: 2,
      items: [
        {
          id: 'rfnd_OldFailed',
          status: 'failed',
          amount: 150_000,
          receipt: refundInput.receipt,
        },
        {
          id: 'rfnd_Mine',
          status: 'processed',
          amount: 150_000,
          receipt: refundInput.receipt,
        },
      ],
    });
    await expect(provider.refund(refundInput)).resolves.toEqual({
      refundId: 'rfnd_Mine',
      status: 'processed',
    });
    expect(client.payments.refund).not.toHaveBeenCalled();
  });

  it('ignores failed earlier refunds and tries again', async () => {
    const { provider, client } = providerWithFakeClient();
    client.payments.fetchMultipleRefund.mockResolvedValue({
      entity: 'collection',
      count: 1,
      items: [
        {
          id: 'rfnd_Failed',
          status: 'failed',
          amount: 150_000,
          receipt: refundInput.receipt,
        },
      ],
    });
    client.payments.refund.mockResolvedValue({
      id: 'rfnd_Second',
      status: 'pending',
    });
    await expect(provider.refund(refundInput)).resolves.toMatchObject({
      refundId: 'rfnd_Second',
    });
  });

  it('turns SDK errors (plain objects) into readable errors for the job to retry', async () => {
    const { provider, client } = providerWithFakeClient();
    client.payments.fetchMultipleRefund.mockRejectedValue({
      statusCode: 502,
      error: { description: 'Bad gateway' },
    });
    await expect(provider.refund(refundInput)).rejects.toThrow(
      'Razorpay refund failed: 502 Bad gateway',
    );
  });
});

describe('MockProvider refunds', () => {
  it('are processed at once and idempotent per payment', async () => {
    const provider = new MockProvider();
    const first = await provider.refund(refundInput);
    expect(first).toMatchObject({
      status: 'processed',
      refundId: expect.stringMatching(/^mock_rfnd_/),
    });
    await expect(provider.refund(refundInput)).resolves.toEqual(first);
    await expect(provider.fetchPayment('mock_pay_1')).rejects.toThrow();
  });
});

describe('money policy', () => {
  it('uses the defaults until AppConfig provides values', () => {
    const config = {} as AppConfig;
    expect(saleCreditHoldMs(config)).toBe(7 * 24 * 3600_000);
    expect(upiCoolingOffMs(config)).toBe(24 * 3600_000);
    expect(checkoutTtlMs(config)).toBe(30 * 60_000);
  });

  it('prefers AppConfig values, and never goes below zero', () => {
    const config = {
      saleCreditHoldDays: 0,
      upiChangeCoolingOffHours: 48,
      checkoutTtlMinutes: -5,
    } as unknown as AppConfig;
    expect(saleCreditHoldMs(config)).toBe(0);
    expect(upiCoolingOffMs(config)).toBe(48 * 3600_000);
    expect(checkoutTtlMs(config)).toBe(60_000);
  });
});
