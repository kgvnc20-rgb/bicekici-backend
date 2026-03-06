import { Injectable, Logger } from '@nestjs/common';
import { PushProvider, PushSendParams, PushSendResult } from './push-provider.interface';

/**
 * No-Op Push Provider
 *
 * Logs push notifications but doesn't send them.
 * Used in development when no push service is configured.
 */
@Injectable()
export class NoopPushProvider implements PushProvider {
    readonly name = 'noop';
    private readonly logger = new Logger('NoopPush');

    async send(params: PushSendParams): Promise<PushSendResult> {
        this.logger.debug(
            `Push notification (noop): "${params.title}" → token: ${params.token?.substring(0, 12)}...`
        );
        return { success: true, messageId: `noop_${Date.now()}` };
    }

    async sendBatch(params: PushSendParams[]): Promise<PushSendResult[]> {
        this.logger.debug(`Batch push (noop): ${params.length} notifications`);
        return params.map(() => ({ success: true, messageId: `noop_${Date.now()}` }));
    }
}
