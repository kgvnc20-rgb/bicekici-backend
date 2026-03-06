import { Injectable, Logger } from '@nestjs/common';
import {
    PaymentProvider,
    PaymentInitiateParams,
    PaymentInitiateResult,
    PaymentConfirmResult,
    RefundResult,
} from './payment-provider.interface';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Iyzipay = require('iyzipay');

/**
 * Iyzico Payment Provider
 *
 * Integrates iyzico's Checkout Form flow:
 *   1. initiate()       → CF Initialize → returns embeddable HTML form
 *   2. handleCallback() → CF Retrieve   → validates token, returns payment result
 *   3. refund()         → Refund API    → partial or full refund
 *
 * Configuration via env:
 *   IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL
 *
 * Sandbox base URL:  https://sandbox-api.iyzipay.com
 * Production URL:    https://api.iyzipay.com
 */
@Injectable()
export class IyzicoPaymentProvider implements PaymentProvider {
    readonly name = 'iyzico';
    private readonly logger = new Logger('IyzicoPayment');
    private readonly iyzipay: any;

    constructor() {
        const apiKey = process.env.IYZICO_API_KEY;
        const secretKey = process.env.IYZICO_SECRET_KEY;
        const uri = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';

        if (!apiKey || !secretKey) {
            throw new Error(
                'Iyzico credentials missing. Set IYZICO_API_KEY and IYZICO_SECRET_KEY environment variables.',
            );
        }

        this.iyzipay = new Iyzipay({ apiKey, secretKey, uri });
        this.logger.log(`Initialized iyzico provider (${uri})`);
    }

    // ─── Initiate: Checkout Form Initialize ───

    async initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult> {
        const conversationId = `bicekici_job_${params.jobId}_${Date.now()}`;
        const basketId = `BASKET_${params.jobId}`;

        const callbackUrl = params.callbackUrl || `${process.env.FRONTEND_URL}/payment/callback`;

        const request = {
            locale: Iyzipay.LOCALE.TR,
            conversationId,
            price: String(params.amount),
            paidPrice: String(params.amount),
            currency: Iyzipay.CURRENCY.TRY,
            basketId,
            paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
            callbackUrl,
            enabledInstallments: [1], // Single payment only
            buyer: {
                id: `BUYER_${params.jobId}`,
                name: params.buyer.firstName || 'Misafir',
                surname: params.buyer.lastName || 'Müşteri',
                gsmNumber: this.formatPhone(params.buyer.phone),
                email: params.buyer.email || 'misafir@bicekici.com',
                identityNumber: '11111111111', // TC Kimlik — required by iyzico, use placeholder for guests
                registrationAddress: 'Türkiye',
                ip: params.buyer.ip || '85.34.78.112',
                city: 'Istanbul',
                country: 'Turkey',
            },
            shippingAddress: {
                contactName: `${params.buyer.firstName || 'Misafir'} ${params.buyer.lastName || ''}`.trim(),
                city: 'Istanbul',
                country: 'Turkey',
                address: 'Çekici hizmeti',
            },
            billingAddress: {
                contactName: `${params.buyer.firstName || 'Misafir'} ${params.buyer.lastName || ''}`.trim(),
                city: 'Istanbul',
                country: 'Turkey',
                address: 'Çekici hizmeti',
            },
            basketItems: [
                {
                    id: `ITEM_${params.jobId}`,
                    name: 'Çekici Hizmeti',
                    category1: 'Taşımacılık',
                    category2: 'Yol Yardım',
                    itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
                    price: String(params.amount),
                },
            ],
        };

        this.logger.log(`CF Initialize: job #${params.jobId}, amount: ${params.amount} TRY`);

        const result = await this.promisify<any>(
            (cb: any) => this.iyzipay.checkoutFormInitialize.create(request, cb),
        );

        if (result.status !== 'success') {
            this.logger.error(`CF Initialize failed: ${result.errorMessage}`);
            throw new Error(`Iyzico initialization failed: ${result.errorMessage}`);
        }

        this.logger.log(`CF Initialize OK: token=${result.token?.substring(0, 20)}...`);
        this.logger.log(`CF checkoutFormContent length: ${result.checkoutFormContent?.length || 0}`);
        this.logger.log(`CF paymentPageUrl: ${result.paymentPageUrl || 'N/A'}`);
        if (result.checkoutFormContent) {
            this.logger.debug(`CF checkoutFormContent preview: ${result.checkoutFormContent.substring(0, 300)}`);
        }

        return {
            providerPaymentId: result.token, // iyzico token — used in CF Retrieve
            status: 'REQUIRES_ACTION',
            htmlContent: result.checkoutFormContent,
            actionUrl: result.paymentPageUrl, // Full page URL — fallback only (htmlContent is preferred for mobile WebView)
        };
    }

    // ─── Handle Callback: Checkout Form Retrieve ───

    async handleCallback(payload: any): Promise<PaymentConfirmResult> {
        const token = payload.token;

        if (!token) {
            this.logger.error('CF Retrieve: no token in callback payload');
            return {
                providerPaymentId: '',
                status: 'FAILED',
                amount: 0,
                currency: 'TRY',
                errorMessage: 'Missing token in callback',
            };
        }

        this.logger.log(`CF Retrieve: token=${token.substring(0, 20)}...`);

        const result = await this.promisify<any>(
            (cb: any) => this.iyzipay.checkoutForm.retrieve({ token }, cb),
        );

        if (result.status !== 'success' || result.paymentStatus !== 'SUCCESS') {
            this.logger.warn(
                `CF Retrieve: payment failed — status=${result.status}, ` +
                `paymentStatus=${result.paymentStatus}, error=${result.errorMessage}`,
            );
            return {
                providerPaymentId: result.paymentId || token,
                status: 'FAILED',
                amount: Number(result.price) || 0,
                currency: result.currency || 'TRY',
                errorMessage: result.errorMessage || 'Payment was not successful',
            };
        }

        this.logger.log(
            `CF Retrieve OK: paymentId=${result.paymentId}, price=${result.price} ${result.currency}`,
        );

        return {
            providerPaymentId: result.paymentId,
            status: 'CAPTURED',
            amount: Number(result.price),
            currency: result.currency || 'TRY',
        };
    }

    // ─── Refund ───

    async refund(providerPaymentId: string, amount: number): Promise<RefundResult> {
        this.logger.log(`Refund: paymentId=${providerPaymentId}, amount=${amount}`);

        // iyzico refund requires paymentTransactionId, not paymentId.
        // We store the paymentId from CF Retrieve — in a real scenario,
        // we'd need the paymentTransactionId from the itemTransactions array.
        // For single-item baskets (our case), we retrieve the payment first.
        const paymentDetail = await this.promisify<any>((cb: any) =>
            this.iyzipay.payment.retrieve(
                { locale: Iyzipay.LOCALE.TR, paymentId: providerPaymentId },
                cb,
            ),
        );

        if (paymentDetail.status !== 'success' || !paymentDetail.itemTransactions?.length) {
            this.logger.error(`Refund: could not retrieve payment details: ${paymentDetail.errorMessage}`);
            return {
                success: false,
                errorMessage: paymentDetail.errorMessage || 'Could not retrieve payment for refund',
            };
        }

        // Single-item basket → first transaction
        const txnId = paymentDetail.itemTransactions[0].paymentTransactionId;

        const refundRequest = {
            locale: Iyzipay.LOCALE.TR,
            conversationId: `refund_${providerPaymentId}_${Date.now()}`,
            paymentTransactionId: txnId,
            price: String(amount),
            currency: Iyzipay.CURRENCY.TRY,
            reason: Iyzipay.REFUND_REASON.BUYER_REQUEST,
            description: 'BiÇekici — İş iptali iadesi',
        };

        const result = await this.promisify<any>((cb: any) =>
            this.iyzipay.refund.create(refundRequest, cb),
        );

        if (result.status !== 'success') {
            this.logger.error(`Refund failed: ${result.errorMessage}`);
            return {
                success: false,
                errorMessage: result.errorMessage,
            };
        }

        this.logger.log(`Refund OK: paymentTransactionId=${txnId}`);

        return {
            success: true,
            providerRefundId: txnId,
        };
    }

    // ─── Helpers ───

    /**
     * Convert iyzipay callback-style API to Promise.
     */
    private promisify<T>(fn: (cb: (err: any, result: T) => void) => void): Promise<T> {
        return new Promise((resolve, reject) => {
            fn((err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    }

    /**
     * Format phone to iyzico-expected format (+905XXXXXXXXX).
     */
    private formatPhone(phone?: string): string {
        if (!phone) return '+905000000000';
        let cleaned = phone.replace(/\D/g, '');
        if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
        if (!cleaned.startsWith('90')) cleaned = '90' + cleaned;
        return '+' + cleaned;
    }
}
