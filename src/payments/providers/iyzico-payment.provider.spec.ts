import { IyzicoPaymentProvider } from './iyzico-payment.provider';
import {
    PaymentInitiateParams,
} from './payment-provider.interface';

/**
 * Unit tests for IyzicoPaymentProvider
 * Mocks the internal iyzipay SDK to avoid real API calls.
 */
describe('IyzicoPaymentProvider', () => {
    let provider: IyzicoPaymentProvider;
    let mockIyzipay: any;

    const sampleParams: PaymentInitiateParams = {
        jobId: 42,
        amount: 350,
        currency: 'TRY',
        description: 'Çekici Hizmeti',
        callbackUrl: 'http://localhost:3000/payment/callback',
        buyer: {
            firstName: 'Ali',
            lastName: 'Yılmaz',
            phone: '05301234567',
            email: 'ali@test.com',
            ip: '85.34.78.112',
        },
    };

    beforeEach(() => {
        // Set required env vars so constructor doesn't throw
        process.env.IYZICO_API_KEY = 'sandbox-test-key';
        process.env.IYZICO_SECRET_KEY = 'sandbox-test-secret';
        process.env.IYZICO_BASE_URL = 'https://sandbox-api.iyzipay.com';

        provider = new IyzicoPaymentProvider();

        // Access the internal iyzipay instance and replace with mocks
        mockIyzipay = (provider as any).iyzipay;
    });

    afterEach(() => {
        delete process.env.IYZICO_API_KEY;
        delete process.env.IYZICO_SECRET_KEY;
        delete process.env.IYZICO_BASE_URL;
    });

    // ─── Constructor ───

    it('throws if API key is missing', () => {
        delete process.env.IYZICO_API_KEY;
        delete process.env.IYZICO_SECRET_KEY;
        expect(() => new IyzicoPaymentProvider()).toThrow('Iyzico credentials missing');
    });

    it('has name = iyzico', () => {
        expect(provider.name).toBe('iyzico');
    });

    // ─── Initiate ───

    it('returns REQUIRES_ACTION with htmlContent on successful CF init', async () => {
        mockIyzipay.checkoutFormInitialize = {
            create: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'success',
                token: 'cf_token_abc123',
                checkoutFormContent: '<div id="iyzipay-checkout-form">...</div>',
            })),
        };

        const result = await provider.initiate(sampleParams);

        expect(result.status).toBe('REQUIRES_ACTION');
        expect(result.htmlContent).toContain('iyzipay-checkout-form');
        expect(result.providerPaymentId).toBe('cf_token_abc123');
    });

    it('throws on CF init failure', async () => {
        mockIyzipay.checkoutFormInitialize = {
            create: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'failure',
                errorMessage: 'Invalid API key',
            })),
        };

        await expect(provider.initiate(sampleParams)).rejects.toThrow('Iyzico initialization failed');
    });

    // ─── Handle Callback ───

    it('returns CAPTURED on successful CF retrieve', async () => {
        mockIyzipay.checkoutForm = {
            retrieve: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'success',
                paymentStatus: 'SUCCESS',
                paymentId: 'iyz_pay_123',
                price: '350.00',
                currency: 'TRY',
            })),
        };

        const result = await provider.handleCallback({ token: 'cf_token_abc123' });

        expect(result.status).toBe('CAPTURED');
        expect(result.providerPaymentId).toBe('iyz_pay_123');
        expect(result.amount).toBe(350);
    });

    it('returns FAILED on unsuccessful payment', async () => {
        mockIyzipay.checkoutForm = {
            retrieve: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'success',
                paymentStatus: 'FAILURE',
                paymentId: 'iyz_pay_fail',
                price: '0',
                errorMessage: 'Insufficient funds',
            })),
        };

        const result = await provider.handleCallback({ token: 'cf_token_fail' });

        expect(result.status).toBe('FAILED');
        expect(result.errorMessage).toContain('Insufficient funds');
    });

    it('returns FAILED when no token provided', async () => {
        const result = await provider.handleCallback({});

        expect(result.status).toBe('FAILED');
        expect(result.errorMessage).toContain('Missing token');
    });

    // ─── Refund ───

    it('performs refund via paymentTransactionId', async () => {
        mockIyzipay.payment = {
            retrieve: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'success',
                itemTransactions: [
                    { paymentTransactionId: 'txn_001' },
                ],
            })),
        };
        mockIyzipay.refund = {
            create: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'success',
            })),
        };

        const result = await provider.refund('iyz_pay_123', 350);

        expect(result.success).toBe(true);
        expect(result.providerRefundId).toBe('txn_001');
    });

    it('returns failure when payment retrieval fails for refund', async () => {
        mockIyzipay.payment = {
            retrieve: jest.fn((_req: any, cb: any) => cb(null, {
                status: 'failure',
                errorMessage: 'Payment not found',
            })),
        };

        const result = await provider.refund('unknown_pay', 100);

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain('Payment not found');
    });

    // ─── Phone Formatting ───

    it('formats phone numbers correctly', () => {
        const formatPhone = (provider as any).formatPhone.bind(provider);
        expect(formatPhone('05301234567')).toBe('+905301234567');
        expect(formatPhone('5301234567')).toBe('+905301234567');
        expect(formatPhone('+905301234567')).toBe('+905301234567');
        expect(formatPhone(undefined)).toBe('+905000000000');
    });
});
