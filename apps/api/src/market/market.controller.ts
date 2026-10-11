import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApprovedChannel, type AuthUser, CurrentUser, Roles } from '../common/auth.decorators.js';
import { MarketIncidentsQuery, MarketMediaQuery } from './market.dto.js';
import { MarketService } from './market.service.js';

/**
 * Marketplace for news channels. The global guards enforce, for every route here:
 * logged in (JwtAuthGuard) -> role CHANNEL or ADMIN -> channel approved by an admin (RolesGuard).
 */
@Controller('market')
@Roles('CHANNEL', 'ADMIN')
@ApprovedChannel()
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get('media')
  listMedia(@CurrentUser() user: AuthUser, @Query() query: MarketMediaQuery) {
    return this.market.listMedia(user, query);
  }

  // ParseUUIDPipe turns a malformed id into a 400 instead of a database error.
  @Get('media/:id')
  getMedia(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.market.getMedia(user, id);
  }

  @Get('incidents')
  listIncidents(@Query() query: MarketIncidentsQuery) {
    return this.market.listIncidents(query);
  }

  @Get('incidents/:id')
  getIncident(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.market.getIncident(user, id);
  }
}
