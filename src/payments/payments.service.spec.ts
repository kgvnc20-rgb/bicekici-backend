import { PaymentsService } from './payments.service';

/**
 * Unit tests for PaymentsService
 * All deps injected directly via constructor (avoids NestJS forwardRef DI).
 */
describe('PaymentsService', () => {
    let service: PaymentsService;
    let prisma: any;
    let jobsService: any;
    let authService: any;
    let paymentProvider: any;
    let idempotencyService: any;
    let gateway: any;

    beforeEach(() => {
        prisma = {
            payment: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
            serviceRequest: { update: jest.fn(), findUnique: jest.fn() },
        };
        jobsService = {
            createQuoteJob: jest.fn(),
            dispatchJob: jest.fn(),
        };
        authService = {
            generateGuestToken: jest.fn().mockReturnValue('mock_guest_token'),
        };
        paymentProvider = {
            initiate: jest.fn(),
            handleCallback: jest.fn(),
            refund: jest.fn(),
        };
        idempotencyService = {
            generateKey: jest.fn().mockReturnValue('idempotent:mock_key'),
            checkAndSet: jest.fn().mockResolvedValue(true), // true = new, proceed
            storeResult: jest.fn().mockResolvedValue(undefined),
            getStoredResult: jest.fn().mockResolvedValue(null),
            release: jest.fn().mockResolvedValue(undefined),
        };
        gateway = {
            notifyJobUpdate: jest.fn(),
            notifyAdmin: jest.fn(),
        };

        service = new PaymentsService(
            prisma,
            jobsService,
            authService,
            gateway,
            paymentProvider,
            idempotencyService,
        );
    });

    describe('initPayment', () => {
        it('initiates payment via provider and returns result', async () => {
            paymentProvider.initiate.mockResolvedValue({
                success: true,
                providerPaymentId: 'pay_init_1',
                status: 'captured',
            });
            prisma.payment.create.mockResolvedValue({ id: 1 });

            const result = await service.initPayment({
                estimatedPrice: 500,
                firstName: 'Test',
                lastName: 'User',
                phone: '05551234567',
                email: 'test@example.com',
            });

            expect(paymentProvider.initiate).toHaveBeenCalled();
            expect(result).toBeDefined();
        });
    });

    describe('mockConfirmPayment', () => {
        it('creates job from quote data and confirms payment', async () => {
            jobsService.createQuoteJob.mockResolvedValue({ id: 55, estimatedPrice: 350 });
            paymentProvider.initiate.mockResolvedValue({
                success: true,
                providerPaymentId: 'sandbox_pay_1',
                status: 'captured',
            });
            prisma.payment.create.mockResolvedValue({ id: 2 });
            prisma.serviceRequest.update.mockResolvedValue({ id: 55, status: 'MATCHING' });
            jobsService.dispatchJob.mockResolvedValue({ dispatched: true, count: 3 });

            const quoteData = {
                pickupAddress: 'Istanbul A',
                dropoffAddress: 'Istanbul B',
                vehicleType: 'CAR',
                distanceKm: 15,
                estimatedPrice: 350,
            };

            const result = await service.mockConfirmPayment(quoteData, undefined);

            expect(result).toBeDefined();
            expect(jobsService.createQuoteJob).toHaveBeenCalled();
            expect(idempotencyService.storeResult).toHaveBeenCalled();
        });

        it('returns cached result for duplicate request (idempotency)', async () => {
            const cachedResult = { jobId: 42, status: 'MATCHING' };
            idempotencyService.checkAndSet.mockResolvedValue(false); // false = duplicate
            idempotencyService.getStoredResult.mockResolvedValue(cachedResult);

            const result = await service.mockConfirmPayment({
                pickupAddress: 'A', dropoffAddress: 'B', vehicleType: 'CAR',
            }, undefined);

            expect(result).toEqual(cachedResult);
            expect(jobsService.createQuoteJob).not.toHaveBeenCalled();
        });
    });

    describe('refund on failure', () => {
        it('releases idempotency key when payment fails', async () => {
            jobsService.createQuoteJob.mockResolvedValue({ id: 66, estimatedPrice: 400 });
            paymentProvider.initiate.mockResolvedValue({
                success: false,
                errorMessage: 'Card declined',
            });

            const quoteData = {
                pickupAddress: 'A', dropoffAddress: 'B', vehicleType: 'CAR', estimatedPrice: 400,
            };

            try {
                await service.mockConfirmPayment(quoteData, undefined);
            } catch (e) {
                // Expected to throw on payment failure
            }

            expect(idempotencyService.release).toHaveBeenCalled();
        });
    });
});
