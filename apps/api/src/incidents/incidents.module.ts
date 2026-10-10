import { Global, Module } from '@nestjs/common';
import { IncidentsService } from './incidents.service.js';

@Global()
@Module({ providers: [IncidentsService], exports: [IncidentsService] })
export class IncidentsModule {}
