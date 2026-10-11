import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, InjectDb } from '../db/db.module.js';
import { media, reports } from '../db/schema.js';
import type { CreateReportDto } from './reports.dto.js';

/**
 * Grievance / takedown requests from anyone (people shown in footage, copyright
 * owners, viewers). The IT Rules require an intermediary to accept and resolve
 * these, so the form is public and needs no account.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(@InjectDb() private readonly db: Database) {}

  async create(dto: CreateReportDto): Promise<{ id: string; status: 'OPEN' }> {
    if (dto.mediaId) {
      const exists = await this.db.query.media.findFirst({
        where: eq(media.id, dto.mediaId),
        columns: { id: true },
      });
      if (!exists) throw new NotFoundException('Media not found');
    }

    const [report] = await this.db
      .insert(reports)
      .values({
        mediaId: dto.mediaId ?? null,
        reporterEmail: dto.reporterEmail,
        reason: dto.reason,
        details: dto.details || null,
      })
      .returning({ id: reports.id });

    // Some reasons (e.g. non-consensual imagery) must be handled within hours.
    this.logger.warn(
      `New ${dto.reason} report ${report.id}${dto.mediaId ? ` for media ${dto.mediaId}` : ''}`,
    );
    return { id: report.id, status: 'OPEN' };
  }
}
