import type { Metadata } from 'next';
import { MyFootage } from './my-footage';

export const metadata: Metadata = { title: 'My footage' };

export default function DashboardPage() {
  return <MyFootage />;
}
