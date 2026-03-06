/**
 * Push Notification Provider Interface
 *
 * All push notification delivery goes through this contract.
 * Implementations: NoopPushProvider (dev), FcmPushProvider (future).
 */

export interface PushSendParams {
    /** FCM/APNs device token */
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}

export interface PushSendResult {
    success: boolean;
    messageId?: string;
    errorMessage?: string;
}

export interface PushProvider {
    readonly name: string;

    /** Send a push notification to a device */
    send(params: PushSendParams): Promise<PushSendResult>;

    /** Send to multiple devices */
    sendBatch(params: PushSendParams[]): Promise<PushSendResult[]>;
}

/** DI Token */
export const PUSH_PROVIDER = 'PUSH_PROVIDER';
