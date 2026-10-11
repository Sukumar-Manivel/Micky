import { Module } from '@nestjs/common';
import { MarketController } from './market.controller.js';
import { MarketService } from './market.service.js';

/** Browse approved media and incidents (news channels and admins). See docs/API.md, "Marketplace". */
@Module({
  controllers: [MarketController],
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
