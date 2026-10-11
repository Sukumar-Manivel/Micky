import { Module } from '@nestjs/common';
import { ProcessingModule } from '../processing/processing.module.js';
import { StreamController } from './stream.controller.js';
import { StreamService } from './stream.service.js';

/** Preview sessions (signed HLS / image URLs), thumbnails and paid downloads. See docs/API.md. */
@Module({
  imports: [ProcessingModule], // MediaQueue (render and delivery jobs) and RedisService
  controllers: [StreamController],
  providers: [StreamService],
})
export class StreamModule {}
