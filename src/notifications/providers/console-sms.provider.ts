import { Injectable, Logger } from '@nestjs/common';
import { SmsProvider, SmsSendResult } from './sms-provider.interface';

/**
 * Console SMS Provider
 *
 * Logs SMS messages to the console instead of sending them.
 * Functionally identical to the previous inline stub.
 * In dev mode, this is the default provider.
 */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
    readonly name = 'console';
    private readonly logger = new Logger('ConsoleSMS');

    async send(phone: string, message: string): Promise<SmsSendResult> {
        this.logger.log('--------------------------------------------------');
        this.logger.log('📲 SMS (Console Provider)');
        this.logger.log(`   To:      ${phone}`);
        this.logger.log(`   Message: ${message}`);
        this.logger.log('--------------------------------------------------');

        return {
            success: true,
            messageId: `console_${Date.now()}`,
        };
    }
}
