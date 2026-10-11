import type { reports } from '../db/schema.js';

type ReportRow = typeof reports.$inferSelect;

/** The "Report" type in docs/API.md: what admins see about a grievance. */
export interface ReportView {
  id: string;
  mediaId: string | null;
  reporterEmail: string;
  reason: ReportRow['reason'];
  details: string | null;
  status: ReportRow['status'];
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function toReportView(row: ReportRow): ReportView {
  return {
    id: row.id,
    mediaId: row.mediaId,
    reporterEmail: row.reporterEmail,
    reason: row.reason,
    details: row.details,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
