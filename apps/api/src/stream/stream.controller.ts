import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { type AuthUser, CurrentUser, Public, Roles } from '../common/auth.decorators.js';
import { type FileToSend, StreamService } from './stream.service.js';

const NO_STORE = 'private, no-store';

/**
 * Preview sessions and the token-protected file routes.
 *
 * Browsers (and HLS players) load these files directly, so they cannot send an
 * Authorization header. Instead, the logged-in endpoint POST /market/media/:id/preview
 * hands out short-lived signed URLs, and the public routes below check the token.
 */
@Controller()
export class StreamController {
  private readonly logger = new Logger(StreamController.name);

  constructor(private readonly streams: StreamService) {}

  /**
   * Not @ApprovedChannel(): the owner UPLOADER must pass too, so the service
   * checks the channel's approval itself. Throttled more tightly than the default,
   * since each call mints new signed URLs.
   */
  @Post('market/media/:id/preview')
  @HttpCode(200)
  @Roles('CHANNEL', 'ADMIN', 'UPLOADER')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async createPreview(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.streams.createPreview(user, id);
    // 202 Accepted: the newsroom's marked rendition is still being made (first view).
    if (session.kind === 'preparing') {
      res.status(HttpStatus.ACCEPTED).setHeader('Retry-After', String(session.retryAfterSec));
    }
    return session;
  }

  // ---------- HLS preview (video) ----------
  // A player fetches the playlist once, the key once, then a segment every few
  // seconds, so these routes skip the per-IP rate limit (the token is the protection).

  @Get('stream/:token/index.m3u8')
  @Public()
  @SkipThrottle()
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', NO_STORE)
  playlist(@Param('token') token: string): Promise<string> {
    return this.streams.playlist(token);
  }

  // Declared before ':segment' so "key.bin" and "image.jpg" are not treated as segment names.
  @Get('stream/:token/key.bin')
  @Public()
  @SkipThrottle()
  @Header('Cache-Control', NO_STORE)
  async key(@Param('token') token: string): Promise<StreamableFile> {
    const key = await this.streams.hlsKey(token);
    return new StreamableFile(key, { type: 'application/octet-stream', length: key.length });
  }

  @Get('stream/:token/image.jpg')
  @Public()
  @SkipThrottle()
  @Header('Cache-Control', 'private, max-age=600')
  async image(@Param('token') token: string): Promise<StreamableFile> {
    return toStreamable(await this.streams.previewImage(token));
  }

  @Get('stream/:token/:segment')
  @Public()
  @SkipThrottle()
  @Header('Cache-Control', 'private, max-age=600')
  async segment(@Param('token') token: string, @Param('segment') segment: string): Promise<StreamableFile> {
    return toStreamable(await this.streams.segment(token, segment));
  }

  // ---------- Thumbnails and purchased downloads ----------

  @Get('files/thumb/:token')
  @Public()
  @SkipThrottle()
  @Header('Cache-Control', 'private, max-age=3600')
  async thumbnail(@Param('token') token: string): Promise<StreamableFile> {
    return toStreamable(await this.streams.thumbnail(token));
  }

  /**
   * The buyer's delivery copy. Single-use links (see StreamService.download), 20 per
   * minute per IP. `downloadCount` goes up only when the whole file was sent
   * ('finish' fires after the last byte is handed to the network; an aborted
   * download only fires 'close').
   */
  @Get('files/download/:token')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', NO_STORE)
  async download(@Param('token') token: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.streams.download(token);
    if (file.sha256) {
      // So the buyer can check the bytes: hex for humans, RFC 9530 Repr-Digest for tools.
      res.setHeader('X-Content-SHA256', file.sha256);
      res.setHeader('Repr-Digest', `sha-256=:${Buffer.from(file.sha256, 'hex').toString('base64')}:`);
    }
    const orderId = file.orderId;
    if (orderId) {
      res.on('finish', () => {
        if (res.statusCode !== 200) return;
        this.streams
          .countCompletedDownload(orderId)
          .catch((err: Error) => this.logger.warn(`Could not count download of ${orderId}: ${err.message}`));
      });
    }
    return toStreamable(file);
  }
}

function toStreamable(file: FileToSend): StreamableFile {
  return new StreamableFile(file.stream, {
    type: file.contentType,
    length: file.size,
    // The name is sanitised to [A-Za-z0-9-] plus an extension, so it is safe inside quotes.
    disposition: file.fileName ? `attachment; filename="${file.fileName}"` : undefined,
  });
}
