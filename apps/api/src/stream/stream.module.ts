import { Module } from '@nestjs/common';
import { StreamController } from './stream.controller.js';
import { StreamService } from './stream.service.js';

/** Preview sessions (signed HLS / image URLs), thumbnails and paid downloads. See docs/API.md. */
@Module({
  controllers: [StreamController],
  providers: [StreamService],
})
export class StreamModule {}
