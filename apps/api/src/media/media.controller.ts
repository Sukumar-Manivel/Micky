import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type AuthUser, CurrentUser, Roles } from '../common/auth.decorators.js';
import { DeleteTempUploadInterceptor } from './delete-temp-upload.interceptor.js';
import { ListMyMediaQuery, UpdateMediaDto, UploadMediaDto } from './media.dto.js';
import { MediaService } from './media.service.js';

/** Uploader media routes (docs/API.md, "Uploader: media"). Every route is UPLOADER-only. */
@Controller()
@Roles('UPLOADER')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * Order matters: guards (auth, role) run before any byte is written to disk;
   * then FileInterceptor (multer) saves the file; then DeleteTempUploadInterceptor
   * wraps validation and the handler, and removes the temp file at the end.
   */
  @Post('media')
  @UseInterceptors(FileInterceptor('file'), DeleteTempUploadInterceptor)
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadMediaDto,
  ) {
    return this.media.upload(user, file, dto);
  }

  @Get('me/media')
  list(@CurrentUser() user: AuthUser, @Query() query: ListMyMediaQuery) {
    return this.media.list(user, query);
  }

  @Get('me/media/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.get(user, id);
  }

  @Patch('me/media/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMediaDto) {
    return this.media.update(user, id, dto);
  }

  @Delete('me/media/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.media.remove(user, id);
  }
}
