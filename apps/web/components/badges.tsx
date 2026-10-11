// Status badges, shared by every role so a status always looks the same.
// Each badge pairs colour with text (never colour alone) for colour-blind users.

import { CATEGORY_LABEL, STATUS_LABEL } from '@/lib/format';
import type { Category, ChannelStatus, MediaStatus, OrderStatus, PayoutStatus, ReportStatus, RiskLevel } from '@/lib/types';

type Tone = 'neutral' | 'progress' | 'good' | 'warn' | 'bad' | 'signal';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-sunken text-muted border-line',
  progress: 'bg-sunken text-ink border-line',
  good: 'bg-verified-soft text-verified border-verified/30',
  warn: 'bg-caution-soft text-caution border-caution/30',
  bad: 'bg-danger-soft text-danger border-danger/30',
  signal: 'bg-signal-soft text-signal border-signal/30',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-bold ${toneClass[tone]}`}>
      {children}
    </span>
  );
}

const mediaTone: Record<MediaStatus, Tone> = {
  PROCESSING: 'progress',
  IN_REVIEW: 'warn',
  APPROVED: 'good',
  REJECTED: 'bad',
  FAILED: 'bad',
  REMOVED: 'neutral',
};

export function MediaStatusBadge({ status }: { status: MediaStatus }) {
  return (
    <Badge tone={mediaTone[status]}>
      {status === 'PROCESSING' ? (
        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      ) : null}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const riskTone: Record<RiskLevel, Tone> = { LOW: 'good', MEDIUM: 'warn', HIGH: 'bad' };
const riskLabel: Record<RiskLevel, string> = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk' };

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <Badge tone={riskTone[risk]}>{riskLabel[risk]}</Badge>;
}

export function CategoryBadge({ category }: { category: Category }) {
  return <Badge tone="signal">{CATEGORY_LABEL[category]}</Badge>;
}

const orderTone: Record<OrderStatus, Tone> = {
  CREATED: 'warn',
  PAID: 'good',
  FAILED: 'bad',
  EXPIRED: 'neutral',
  REFUND_PENDING: 'progress',
  REFUNDED: 'neutral',
  REFUND_FAILED: 'bad',
  DISPUTED: 'bad',
};
const orderLabel: Record<OrderStatus, string> = {
  CREATED: 'Awaiting payment',
  PAID: 'Paid',
  FAILED: 'Payment failed',
  EXPIRED: 'Expired',
  REFUND_PENDING: 'Refund in progress',
  REFUNDED: 'Refunded',
  // The buyer is told the truth: support is retrying it, it is not "on its way" by itself.
  REFUND_FAILED: 'Refund delayed',
  DISPUTED: 'Disputed',
};
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={orderTone[status]}>{orderLabel[status]}</Badge>;
}

const payoutTone: Record<PayoutStatus, Tone> = { REQUESTED: 'warn', PAID: 'good', REJECTED: 'bad' };
const payoutLabel: Record<PayoutStatus, string> = { REQUESTED: 'Requested', PAID: 'Paid', REJECTED: 'Rejected' };
export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return <Badge tone={payoutTone[status]}>{payoutLabel[status]}</Badge>;
}

const reportTone: Record<ReportStatus, Tone> = { OPEN: 'warn', RESOLVED: 'good', DISMISSED: 'neutral' };
const reportLabel: Record<ReportStatus, string> = { OPEN: 'Open', RESOLVED: 'Resolved', DISMISSED: 'Dismissed' };
export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return <Badge tone={reportTone[status]}>{reportLabel[status]}</Badge>;
}

const channelTone: Record<ChannelStatus, Tone> = { PENDING: 'warn', APPROVED: 'good', REJECTED: 'bad' };
const channelLabel: Record<ChannelStatus, string> = { PENDING: 'Awaiting approval', APPROVED: 'Approved', REJECTED: 'Rejected' };
export function ChannelStatusBadge({ status }: { status: ChannelStatus }) {
  return <Badge tone={channelTone[status]}>{channelLabel[status]}</Badge>;
}
