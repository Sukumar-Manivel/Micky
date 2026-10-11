import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AppConfig } from '../config/app-config.js';
import { ProcessingModule } from '../processing/processing.module.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { tempDiskStorage } from './upload-files.js';

/**
 * Uploader media: upload (POST /media) and the uploader's own list/detail/edit/remove.
 * Processing is NOT done here: MediaService only enqueues a job (ProcessingModule's
 * MediaQueue) and the separate worker process does the heavy work.
 */
@Module({
  imports: [
    ProcessingModule,
    MulterModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // Stream to disk, never into memory: a 500 MB video must not fill the API's RAM.
        storage: tempDiskStorage(config.uploadTmpDir),
        limits: {
          // Multer cannot know the type yet, so it enforces the larger limit (413).
          // MediaService then applies the per-type limit (photos 25 MB).
          fileSize: Math.max(config.maxVideoBytes, config.maxPhotoBytes),
          files: 1,
          fields: 20,
          fieldSize: 16 * 1024,
          parts: 25,
        },
      }),
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
