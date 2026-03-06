import { Injectable, Logger } from '@nestjs/common';
import {
    PaymentProvider,
    PaymentInitiateParams,
    PaymentInitiateResult,
    PaymentConfirmResult,
    RefundResult,
} from './payment-provider.interface';
import * as crypto from 'crypto';

/**
 * Sandbox Payment Provider
 *
 * Mimics real provider behavior for end-to-end testing.
 * NOT a shortcut mock — exercises the full payment flow.
 *
 * Behavior is determined by the amount's decimal portion:
 *   - *.01  → Simulates 3D Secure redirect (REQUIRES_ACTION)
 *   - *.02  → Simulates payment failure
 *   - other → Simulates instant capture (CAPTURED)
 *
 * This allows testing all payment paths without a real provider.
 */
@Injectable()
export class SandboxPaymentProvider implements PaymentProvider {
    readonly name = 'sandbox';
    private readonly logger = new Logger('SandboxPayment');

    async initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult> {
        const providerPaymentId = `sandbox_${crypto.randomUUID()}`;
        const decimalPart = Math.round((params.amount % 1) * 100);

        this.logger.log(
            `Initiating sandbox payment: ${params.amount} ${params.currency} ` +
            `for job #${params.jobId} (scenario: ${this.getScenario(decimalPart)})`
        );

        // Scenario: 3D Secure redirect required
        if (decimalPart === 1) {
            return {
                providerPaymentId,
                status: 'REQUIRES_ACTION',
                actionUrl: `${params.callbackUrl}?paymentId=${providerPaymentId}&status=success`,
                htmlContent: '<div class="sandbox-3d">Sandbox 3D Secure Simulation</div>',
            };
        }

        // Scenario: Payment failure
        if (decimalPart === 2) {
            this.logger.warn(`Sandbox payment FAILED (amount ends in .02): ${providerPaymentId}`);
            // For failures, we return CAPTURED:false via handleCallback
            // But initiate itself returns a "redirect" that will fail
            return {
                providerPaymentId,
                status: 'REQUIRES_ACTION',
                actionUrl: `${params.callbackUrl}?paymentId=${providerPaymentId}&status=failed`,
            };
        }

        // Default: Instant capture
        this.logger.log(`Sandbox payment CAPTURED instantly: ${providerPaymentId}`);
        return {
            providerPaymentId,
            status: 'CAPTURED',
        };
    }

    async handleCallback(payload: any): Promise<PaymentConfirmResult> {
        const paymentId = payload.paymentId || payload.providerPaymentId;
        const status = payload.status;

        this.logger.log(`Sandbox callback: paymentId=${paymentId}, status=${status}`);

        if (status === 'failed') {
            return {
                providerPaymentId: paymentId,
                status: 'FAILED',
                amount: payload.amount || 0,
                currency: payload.currency || 'TRY',
                errorMessage: 'Sandbox: Simulated payment failure (amount ended in .02)',
            };
        }

        return {
            providerPaymentId: paymentId,
            status: 'CAPTURED',
            amount: payload.amount || 0,
            currency: payload.currency || 'TRY',
        };
    }

    async refund(providerPaymentId: string, amount: number): Promise<RefundResult> {
        this.logger.log(`Sandbox refund: ${providerPaymentId}, amount: ${amount}`);
        return {
            success: true,
            providerRefundId: `sandbox_refund_${crypto.randomUUID()}`,
        };
    }

    private getScenario(decimalPart: number): string {
        if (decimalPart === 1) return '3D_SECURE';
        if (decimalPart === 2) return 'FAILURE';
        return 'INSTANT_CAPTURE';
    }
}
