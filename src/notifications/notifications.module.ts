
import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { SMS_PROVIDER } from './providers/sms-provider.interface';
import { ConsoleSmsProvider } from './providers/console-sms.provider';
import { PUSH_PROVIDER } from './providers/push-provider.interface';
import { NoopPushProvider } from './providers/noop-push.provider';

@Module({
    imports: [RealtimeModule],
    providers: [
        NotificationService,
        // ── SMS Provider ──
        // Swap implementation via SMS_PROVIDER env var
        {
            provide: SMS_PROVIDER,
            useFactory: () => {
                const provider = process.env.SMS_PROVIDER || 'console';
                // Future: if (provider === 'netgsm') return new NetgsmSmsProvider();
                return new ConsoleSmsProvider();
            },
        },
        // ── Push Provider ──
        // Swap implementation via PUSH_PROVIDER env var
        {
            provide: PUSH_PROVIDER,
            useFactory: () => {
                const provider = process.env.PUSH_PROVIDER || 'noop';
                // Future: if (provider === 'fcm') return new FcmPushProvider();
                return new NoopPushProvider();
            },
        },
    ],
    exports: [NotificationService, SMS_PROVIDER, PUSH_PROVIDER],
})
export class NotificationsModule { }
