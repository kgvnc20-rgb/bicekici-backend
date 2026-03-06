import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';
import { PricingModule } from './pricing/pricing.module';
import { AuthModule } from './auth/auth.module';
import { JobsModule } from './jobs/jobs.module';
import { DriversModule } from './drivers/drivers.module';
import { RealtimeModule } from './realtime/realtime.module';
import { GeoModule } from './geo/geo.module';
import { RedisModule } from './redis/redis.module';
import { AdminModule } from './admin/admin.module';
import { PaymentsModule } from './payments/payments.module';
import { InvoicesModule } from './invoices/invoices.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        // ── Rate Limiting ──
        // Default: 100 requests per 60 seconds per IP
        // Override per-endpoint with @Throttle() decorator (e.g. auth endpoints → 5/60s)
        // Configurable via env vars for production tightening
        ThrottlerModule.forRoot([{
            ttl: parseInt(process.env.THROTTLE_TTL || '60000', 10),   // ms
            limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
        }]),
        RedisModule,
        PricingModule,
        AuthModule,
        JobsModule,
        DriversModule,
        RealtimeModule,
        GeoModule,
        AdminModule,
        PaymentsModule,
        InvoicesModule,
        NotificationsModule,
    ],
    controllers: [AppController],
    providers: [
        AppService,
        PrismaService,
        // Apply throttler globally — all endpoints protected by default
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule { }
