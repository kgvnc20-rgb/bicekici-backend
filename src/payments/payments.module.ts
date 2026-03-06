
import { Module, forwardRef } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma.service';
import { JobsModule } from '../jobs/jobs.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RedisModule } from '../redis/redis.module';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { SandboxPaymentProvider } from './providers/sandbox-payment.provider';
import { IyzicoPaymentProvider } from './providers/iyzico-payment.provider';
import { IdempotencyService } from '../common/idempotency.service';

@Module({
    imports: [
        forwardRef(() => JobsModule),
        RedisModule,
        forwardRef(() => AuthModule),
        forwardRef(() => RealtimeModule),
    ],
    controllers: [PaymentsController],
    providers: [
        PaymentsService,
        PrismaService,
        IdempotencyService,
        // ── Payment Provider ──
        // Swap implementation via PAYMENT_PROVIDER env var
        {
            provide: PAYMENT_PROVIDER,
            useFactory: () => {
                const provider = process.env.PAYMENT_PROVIDER || 'sandbox';
                if (provider === 'iyzico') {
                    return new IyzicoPaymentProvider();
                }
                return new SandboxPaymentProvider();
            },
        },
    ],
    exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule { }

