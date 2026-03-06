/**
 * Payment Provider Interface
 *
 * All payment processing goes through this contract.
 * Implementations: SandboxPaymentProvider (dev), IyzicoPaymentProvider (future).
 *
 * Flow:
 *   1. initiate() → returns REQUIRES_ACTION (3D redirect) or CAPTURED (instant)
 *   2. handleCallback() → validates provider callback, returns confirmation
 *   3. refund() → reverse a captured payment
 */

export interface PaymentInitiateParams {
    /** Internal job ID (for tracking) */
    jobId: number;
    /** Amount in minor units (e.g., 1250.00 TRY) */
    amount: number;
    currency: string;
    description: string;
    /** URL the provider redirects to after 3D Secure */
    callbackUrl: string;
    buyer: {
        firstName: string;
        lastName: string;
        phone: string;
        email?: string;
        ip?: string;
    };
}

export interface PaymentInitiateResult {
    /** Provider's unique payment ID */
    providerPaymentId: string;
    /** REQUIRES_ACTION = needs 3D redirect; CAPTURED = instant success */
    status: 'REQUIRES_ACTION' | 'CAPTURED';
    /** 3D Secure redirect URL (only when REQUIRES_ACTION) */
    actionUrl?: string;
    /** Provider-rendered checkout form HTML (optional) */
    htmlContent?: string;
}

export interface PaymentConfirmResult {
    providerPaymentId: string;
    status: 'CAPTURED' | 'FAILED';
    amount: number;
    currency: string;
    /** Provider-specific error message on failure */
    errorMessage?: string;
}

export interface RefundResult {
    success: boolean;
    providerRefundId?: string;
    errorMessage?: string;
}

export interface PaymentProvider {
    readonly name: string;

    /** Initialize a payment session */
    initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult>;

    /** Validate and parse a webhook/callback from the provider */
    handleCallback(payload: any): Promise<PaymentConfirmResult>;

    /** Refund a previously captured payment */
    refund(providerPaymentId: string, amount: number): Promise<RefundResult>;
}

/** DI Token */
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';
