import { Module, forwardRef } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { GuestJobsController } from './guest-jobs.controller';
import { JobsService } from './jobs.service';
import { WaveDispatchService } from './wave-dispatch.service';
import { PrismaService } from '../prisma.service';
import { PricingModule } from '../pricing/pricing.module';
import { DriversModule } from '../drivers/drivers.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
    imports: [
        PricingModule,
        forwardRef(() => DriversModule),
        forwardRef(() => RealtimeModule),
        RedisModule,
        NotificationsModule,
        forwardRef(() => AuthModule),
        forwardRef(() => PaymentsModule),
    ],
    controllers: [JobsController, GuestJobsController],
    providers: [JobsService, WaveDispatchService, PrismaService],
    exports: [JobsService, WaveDispatchService],
})
export class JobsModule { }

