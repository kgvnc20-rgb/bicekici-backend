/**
 * SMS Provider Interface
 *
 * All SMS delivery goes through this contract.
 * Implementations: ConsoleSmsProvider (dev), NetgsmSmsProvider (future).
 */

export interface SmsSendResult {
    success: boolean;
    messageId?: string;
    errorMessage?: string;
}

export interface SmsProvider {
    readonly name: string;

    /** Send an SMS message to a phone number */
    send(phone: string, message: string): Promise<SmsSendResult>;
}

/** DI Token */
export const SMS_PROVIDER = 'SMS_PROVIDER';
