
import { Injectable, Logger, Inject } from '@nestjs/common';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PUSH_PROVIDER, PushProvider } from './providers/push-provider.interface';

@Injectable()
export class NotificationService {
    private readonly logger = new Logger(NotificationService.name);

    constructor(
        private readonly realtimeGateway: RealtimeGateway,
        @Inject(PUSH_PROVIDER) private readonly pushProvider: PushProvider,
    ) { }

    /**
     * Notify drivers about a new job or update.
     * Sends via:
     *   1. WebSocket (online drivers, immediate)
     *   2. Push notification (background drivers, via PushProvider)
     */
    async notifyDrivers(driverIds: number[], event: string, payload: any) {
        this.logger.log(`Notifying ${driverIds.length} drivers: ${event}`);

        // 1. Send via WebSocket (best effort, online drivers only)
        for (const driverId of driverIds) {
            this.realtimeGateway.notifyDriver(driverId, event, payload);
        }

        // 2. Send via Push (future: when DriverProfile has fcmToken)
        // This is a no-op with NoopPushProvider, but the plumbing is ready.
        // When FCM is implemented:
        //   - Fetch fcmToken from DriverProfile
        //   - Call this.pushProvider.send({ token, title, body, data })
    }
}
