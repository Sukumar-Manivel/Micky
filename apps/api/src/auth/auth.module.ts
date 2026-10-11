import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginBackoffService } from './rate-limit/login-backoff.service.js';
import { RedisThrottlerStorage } from './rate-limit/redis-throttler.storage.js';
import { createRateLimitRedis, RATE_LIMIT_REDIS, RateLimitRedisCloser } from './rate-limit/redis.provider.js';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: RATE_LIMIT_REDIS, inject: [AppConfig], useFactory: createRateLimitRedis },
    RateLimitRedisCloser,
    RedisThrottlerStorage,
    LoginBackoffService,
  ],
  exports: [AuthService, JwtModule, RedisThrottlerStorage, LoginBackoffService],
})
export class AuthModule {}
