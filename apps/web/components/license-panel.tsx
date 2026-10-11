'use client';

// Shows both licence options and runs checkout:
//   POST /orders → (razorpay) open Razorpay Checkout → POST /orders/:id/verify
//                  (if the payment is authorised but not captured yet, poll GET /orders/:id briefly:
//                   the licence is granted only once the money is captured)
//                → (mock)     show a clearly labelled test dialog → POST /orders/:id/mock-pay
// then shows success with a download button.

import Link from 'next/link';
import { useRef, useState } from 'react';
import { describeError, ordersApi } from '@/lib/api';
import { downloadOriginal } from '@/lib/download';
import { LICENSE_LABEL } from '@/lib/format';
import { formatINR } from '@/lib/money';
import { PaymentCancelled, openRazorpay } from '@/lib/razorpay';
import type { CheckoutView, LicenseType, MediaMarketView, OrderView } from '@/lib/types';
import { useSignedInUser } from './auth-provider';
import { Alert, Button, Panel } from './ui';

const LICENSE_TERMS: Record<LicenseType, string[]> = {
  NON_EXCLUSIVE: [
    'Broadcast, stream and publish in news coverage, worldwide, without time limit.',
    'Other newsrooms may license the same footage.',
  ],
  EXCLUSIVE: [
    'Everything in the non-exclusive licence.',
    'No other newsroom can buy it after you. Only available before anyone else has bought it.',
  ],
};

type Stage =
  | { kind: 'choose' }
  | { kind: 'paying'; license: LicenseType }
  | { kind: 'mock'; checkout: CheckoutView; license: LicenseType }
  | { kind: 'paid'; order: OrderView };

export function LicensePanel({ media, onPurchased }: { media: MediaMarketView; onPurchased: () => void }) {
  const user = useSignedInUser();
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [error, setError] = useState<string | null>(null);

  if (media.purchased && stage.kind !== 'paid') {
    return (
      <Panel aria-labelledby="licence-h" className="border-verified/40">
        <h2 id="licence-h" className="mb-2 text-xl font-bold">
          You hold a licence
        </h2>
        <p className="mb-4 text-muted">{LICENSE_LABEL[media.purchased.licenseType]}. Download the full-quality original below.</p>
        <DownloadButton orderId={media.purchased.orderId} />
      </Panel>
    );
  }

  if (stage.kind === 'paid') {
    return (
      <Panel aria-labelledby="licence-h" className="border-verified/40 bg-verified-soft">
        <h2 id="licence-h" className="mb-2 text-xl font-bold text-verified" role="status">
          Payment received. The licence is yours.
        </h2>
        <p className="mb-4">
          {LICENSE_LABEL[stage.order.licenseType]} for {formatINR(stage.order.amount)}. You can download the original now, and
          any time later from <Link href="/newsroom/purchases" className="underline">Purchases</Link>.
        </p>
        <DownloadButton orderId={stage.order.id} />
      </Panel>
    );
  }

  async function buy(license: LicenseType) {
    setError(null);
    setStage({ kind: 'paying', license });
    try {
      const checkout = await ordersApi.create(media.id, license);
      if (checkout.provider === 'mock') {
        setStage({ kind: 'mock', checkout, license });
        return;
      }
      if (!checkout.razorpay) throw new Error('Payment is not configured. Please contact support.');
      const res = await openRazorpay({
        keyId: checkout.razorpay.keyId,
        orderId: checkout.razorpay.orderId,
        amount: checkout.amount,
        currency: checkout.currency,
        description: checkout.description,
        prefill: { email: user.email, name: user.name },
      });
      const order = await ordersApi.verify(checkout.orderId, res.razorpay_payment_id, res.razorpay_signature);
      finish(order.status === 'CREATED' ? await waitForCapture(order) : order);
    } catch (err) {
      setStage({ kind: 'choose' });
      if (!(err instanceof PaymentCancelled)) setError(describeError(err));
    }
  }

  function finish(order: OrderView) {
    if (order.status === 'PAID') {
      setStage({ kind: 'paid', order });
      onPurchased();
    } else {
      setStage({ kind: 'choose' });
      setError(outcomeMessage(order));
    }
  }

  const options: { license: LicenseType; price: number; available: boolean }[] = [
    { license: 'NON_EXCLUSIVE', price: media.priceNonExclusive, available: media.availability.nonExclusive },
    { license: 'EXCLUSIVE', price: media.priceExclusive, available: media.availability.exclusive },
  ];
  const busyLicense = stage.kind === 'paying' ? stage.license : null;

  return (
    <Panel aria-labelledby="licence-h">
      <h2 id="licence-h" className="mb-1 text-xl font-bold">
        License this footage
      </h2>
      <p className="mb-4 text-sm text-muted">You get the original, full-quality file without a watermark.</p>
      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <ul className="flex flex-col gap-3">
        {options.map((o) => (
          <li key={o.license} className={`rounded-lg border p-4 ${o.available ? 'border-line' : 'border-dashed border-line opacity-70'}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-bold">{LICENSE_LABEL[o.license]}</h3>
              <p className="font-display tabular text-2xl font-bold">{formatINR(o.price)}</p>
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {LICENSE_TERMS[o.license].map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <div className="mt-3">
              {o.available ? (
                <Button
                  className="w-full"
                  variant={o.license === 'EXCLUSIVE' ? 'primary' : 'secondary'}
                  onClick={() => buy(o.license)}
                  busy={busyLicense === o.license}
                  disabled={busyLicense !== null}
                >
                  Buy {o.license === 'EXCLUSIVE' ? 'exclusive' : 'non-exclusive'} licence
                </Button>
              ) : (
                <p className="text-sm font-semibold text-muted">
                  {o.license === 'EXCLUSIVE' ? 'Not available: already licensed to a newsroom.' : 'Not available: licensed exclusively.'}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-muted">
        Payments by Razorpay. By buying you accept the <Link href="/terms#licence" className="underline">licence terms</Link>.
      </p>
      {stage.kind === 'mock' ? (
        <MockPaymentDialog
          checkout={stage.checkout}
          onPaid={finish}
          onCancel={() => setStage({ kind: 'choose' })}
          onError={(msg) => {
            setStage({ kind: 'choose' });
            setError(msg);
          }}
        />
      ) : null}
    </Panel>
  );
}

const CAPTURE_POLL_MS = 2_000;
const CAPTURE_WAIT_MS = 30_000;

/** The bank authorised the payment; Razorpay usually captures it within seconds. */
async function waitForCapture(order: OrderView): Promise<OrderView> {
  const deadline = Date.now() + CAPTURE_WAIT_MS;
  let current = order;
  while (current.status === 'CREATED' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CAPTURE_POLL_MS));
    current = await ordersApi.get(order.id);
  }
  return current;
}

/** What to tell a buyer whose order did not end up PAID. Never promises more than the system does. */
function outcomeMessage(order: OrderView): string {
  switch (order.status) {
    case 'CREATED':
      return (
        'We have not received confirmation of your payment yet. If you were charged, the licence appears under ' +
        'Purchases within a few minutes. If it cannot be granted, a full refund is requested for you.'
      );
    case 'REFUND_PENDING':
    case 'REFUNDED':
    case 'REFUND_FAILED':
      return (
        `${order.statusReason ?? 'This licence could not be granted'}. A full refund of your payment has been requested; ` +
        'banks usually take 5–7 working days to show it. Contact support if it has not arrived by then.'
      );
    case 'EXPIRED':
      return 'This checkout expired. Please start a new purchase.';
    default:
      return 'The payment did not go through. Please try again.';
  }
}

function DownloadButton({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        className="w-full"
        size="lg"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await downloadOriginal(orderId);
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        Download original
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

/**
 * Development-only payment. The API returns provider 'mock' when no Razorpay keys are set,
 * so the whole purchase flow can be demonstrated without real money. A native <dialog> gives
 * us focus trapping and Escape-to-close for free.
 */
function MockPaymentDialog({
  checkout,
  onPaid,
  onCancel,
  onError,
}: {
  checkout: CheckoutView;
  onPaid: (o: OrderView) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  // Open as a modal as soon as it mounts.
  const setRef = (el: HTMLDialogElement | null) => {
    ref.current = el;
    if (el && !el.open) el.showModal();
  };

  async function pay() {
    setBusy(true);
    try {
      onPaid(await ordersApi.mockPay(checkout.orderId));
    } catch (err) {
      onError(describeError(err));
    }
  }

  return (
    <dialog
      ref={setRef}
      onCancel={onCancel}
      aria-labelledby="mock-h"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border-2 border-caution bg-surface p-0 text-ink"
    >
      <div className="bg-caution-soft px-5 py-2 text-sm font-bold text-caution">Test mode: no real money is charged</div>
      <div className="flex flex-col gap-4 p-5">
        <h2 id="mock-h" className="font-display text-3xl font-bold">
          Test payment
        </h2>
        <p>{checkout.description}</p>
        <p className="font-display tabular text-4xl font-bold">{formatINR(checkout.amount)}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={pay} busy={busy} className="flex-1">
            Simulate successful payment
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}
