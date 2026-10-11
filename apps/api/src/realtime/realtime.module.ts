import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LiveGateway } from './live.gateway.js';
import { RealtimeService } from './realtime.service.js';

/**
 * Global so any feature module can inject RealtimeService.
 * It registers its own JwtModule (the secret is passed per call), so it also
 * works in a process that does not load AuthModule, such as the worker.
 * In a process without an HTTP server the gateway never starts, and
 * RealtimeService just drops events.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [RealtimeService, LiveGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
