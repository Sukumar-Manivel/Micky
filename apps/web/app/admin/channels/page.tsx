import type { Metadata } from 'next';
import { ChannelApprovals } from './channel-approvals';

export const metadata: Metadata = { title: 'Newsrooms' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function AdminRoutePage() {
  return <ChannelApprovals />;
}
