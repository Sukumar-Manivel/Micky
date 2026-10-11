import type { Metadata } from 'next';
import { Purchases } from './purchases';

export const metadata: Metadata = { title: 'Purchases' };

export default function PurchasesPage() {
  return <Purchases />;
}
