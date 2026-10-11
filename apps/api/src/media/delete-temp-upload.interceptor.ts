import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { rm } from 'node:fs/promises';
import { finalize, type Observable } from 'rxjs';

/**
 * Deletes multer's temporary file when the request is over, whatever happened:
 * success, a validation error from the ValidationPipe (pipes run *inside*
 * `next.handle()`, so their errors pass through here), a 409 from the service...
 *
 * Must be listed AFTER FileInterceptor so that the file exists when this runs.
 * (If multer itself fails, e.g. the file is too large, multer removes its own partial file.)
 * The service copies the file into storage first, so deleting it here is always safe.
 */
@Injectable()
export class DeleteTempUploadInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DeleteTempUploadInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      finalize(() => {
        const file = request.file?.path;
        if (file) rm(file, { force: true }).catch((err: Error) => this.logger.warn(`Could not delete ${file}: ${err.message}`));
      }),
    );
  }
}
