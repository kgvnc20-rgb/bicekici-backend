import { Test, TestingModule } from '@nestjs/testing';
import { JobsService } from './jobs.service';
import { PrismaService } from '../prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { DriverPresenceService } from '../drivers/driver-presence.service';
import { RedisService } from '../redis/redis.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationService } from '../notifications/notification.service';
import { PAYMENT_PROVIDER } from '../payments/providers/payment-provider.interface';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Unit tests for JobsService.cancelJob()
 * All dependencies are mocked — no DB or Redis needed.
 */
describe('JobsService.cancelJob', () => {
    let service: JobsService;
    let prisma: any;
    let presence: any;
    let paymentProvider: any;
    let gateway: any;

    beforeEach(async () => {
        prisma = {
            serviceRequest: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
            driverProfile: { findUnique: jest.fn() },
            payment: { update: jest.fn() },
        };
        presence = {
            setDriverAvailable: jest.fn(),
        };
        paymentProvider = {
            refund: jest.fn(),
        };
        gateway = {
            notifyJobUpdate: jest.fn(),
            notifyAdmin: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                JobsService,
                { provide: PrismaService, useValue: prisma },
                { provide: PricingService, useValue: {} },
                { provide: DriverPresenceService, useValue: presence },
                { provide: RedisService, useValue: { getClient: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn(), acquireLock: jest.fn(), releaseLock: jest.fn(), sadd: jest.fn(), srem: jest.fn(), smembers: jest.fn() } },
                { provide: RealtimeGateway, useValue: gateway },
                { provide: NotificationService, useValue: {} },
                { provide: PAYMENT_PROVIDER, useValue: paymentProvider },
            ],
        }).compile();

        service = module.get(JobsService);
    });

    // ─── Happy Paths ───

    it('cancels a MATCHING job (no payment → no refund)', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 1, status: 'MATCHING', driverId: null, customerId: 10, payments: [],
        });
        prisma.serviceRequest.update.mockResolvedValue({ id: 1, status: 'CANCELED' });

        const result = await service.cancelJob(1, 'CUSTOMER', 'Changed my mind', 10);

        expect(result.success).toBe(true);
        expect(result.status).toBe('CANCELED');
        expect(result.refund).toBeNull();
        expect(paymentProvider.refund).not.toHaveBeenCalled();
    });

    it('cancels ASSIGNED job with captured payment → triggers refund', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 2, status: 'ASSIGNED', driverId: 5, customerId: 10,
            payments: [{ id: 100, status: 'CAPTURED', providerPaymentId: 'pay_123', amount: 450 }],
        });
        prisma.serviceRequest.update.mockResolvedValue({ id: 2, status: 'CANCELED' });
        paymentProvider.refund.mockResolvedValue({ success: true, providerRefundId: 'ref_456' });

        const result = await service.cancelJob(2, 'CUSTOMER', 'Found alternative', 10);

        expect(result.success).toBe(true);
        expect(result.refund).toEqual({ success: true, amount: 450 });
        expect(paymentProvider.refund).toHaveBeenCalledWith('pay_123', 450);
        expect(prisma.payment.update).toHaveBeenCalledWith({
            where: { id: 100 },
            data: { status: 'REFUNDED' },
        });
    });

    it('frees the assigned driver on cancellation', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 3, status: 'ASSIGNED', driverId: 7, customerId: 10, payments: [],
        });
        prisma.serviceRequest.update.mockResolvedValue({ id: 3, status: 'CANCELED' });

        await service.cancelJob(3, 'CUSTOMER', undefined, 10);

        expect(presence.setDriverAvailable).toHaveBeenCalledWith(7);
    });

    it('returns idempotent result for already-CANCELED job', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 4, status: 'CANCELED', driverId: null, customerId: 10, payments: [],
        });

        const result = await service.cancelJob(4, 'CUSTOMER', undefined, 10);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Already cancelled');
        expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
    });

    // ─── Guard Rails ───

    it('throws NotFoundException for non-existent job', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue(null);

        await expect(service.cancelJob(999, 'CUSTOMER')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for DELIVERED job', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 5, status: 'DELIVERED', customerId: 10, payments: [],
        });

        await expect(service.cancelJob(5, 'CUSTOMER', undefined, 10)).rejects.toThrow(BadRequestException);
    });

    it('throws when customer cancels EN_ROUTE_TO_DROPOFF', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 6, status: 'EN_ROUTE_TO_DROPOFF', driverId: 5, customerId: 10, payments: [],
        });

        await expect(service.cancelJob(6, 'CUSTOMER', undefined, 10)).rejects.toThrow(BadRequestException);
    });

    it('admin CAN cancel EN_ROUTE_TO_DROPOFF', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 7, status: 'EN_ROUTE_TO_DROPOFF', driverId: 5, customerId: 10, payments: [],
        });
        prisma.serviceRequest.update.mockResolvedValue({ id: 7, status: 'CANCELED' });

        const result = await service.cancelJob(7, 'ADMIN', 'Emergency override');

        expect(result.success).toBe(true);
    });

    it('throws ForbiddenException when wrong customer cancels', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 8, status: 'MATCHING', customerId: 10, payments: [],
        });

        await expect(service.cancelJob(8, 'CUSTOMER', undefined, 99)).rejects.toThrow(ForbiddenException);
    });

    // ─── Notifications ───

    it('sends real-time notifications on cancel', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 9, status: 'MATCHING', driverId: null, customerId: 10, payments: [],
        });
        prisma.serviceRequest.update.mockResolvedValue({ id: 9, status: 'CANCELED' });

        await service.cancelJob(9, 'CUSTOMER', 'Test reason', 10);

        expect(gateway.notifyJobUpdate).toHaveBeenCalledWith(9, 'job:status_changed', expect.objectContaining({
            jobId: 9,
            status: 'CANCELED',
        }));
        expect(gateway.notifyAdmin).toHaveBeenCalledWith('job:cancelled', expect.objectContaining({
            jobId: 9,
            cancelledBy: 'CUSTOMER',
        }));
    });

    // ─── Refund Error Handling ───

    it('still cancels job even if refund fails', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 10, status: 'ASSIGNED', driverId: 5, customerId: 10,
            payments: [{ id: 200, status: 'CAPTURED', providerPaymentId: 'pay_fail', amount: 300 }],
        });
        prisma.serviceRequest.update.mockResolvedValue({ id: 10, status: 'CANCELED' });
        paymentProvider.refund.mockRejectedValue(new Error('Provider timeout'));

        const result = await service.cancelJob(10, 'CUSTOMER', undefined, 10);

        // Job should still be cancelled
        expect(result.success).toBe(true);
        expect(result.status).toBe('CANCELED');
        // Refund was attempted but failed — result should be null
        expect(result.refund).toBeNull();
    });
});
