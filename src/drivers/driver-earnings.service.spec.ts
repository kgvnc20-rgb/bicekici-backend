import { Test, TestingModule } from '@nestjs/testing';
import { DriverEarningsService } from './driver-earnings.service';
import { PrismaService } from '../prisma.service';

describe('DriverEarningsService', () => {
    let service: DriverEarningsService;
    let prisma: {
        driverProfile: { findUnique: jest.Mock };
        serviceRequest: { findMany: jest.Mock; aggregate: jest.Mock };
    };

    beforeEach(async () => {
        prisma = {
            driverProfile: { findUnique: jest.fn() },
            serviceRequest: { findMany: jest.fn(), aggregate: jest.fn() },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DriverEarningsService,
                { provide: PrismaService, useValue: prisma },
            ],
        }).compile();

        service = module.get(DriverEarningsService);
    });

    it('returns null if driver not found', async () => {
        prisma.driverProfile.findUnique.mockResolvedValue(null);

        const result = await service.getEarningsSummary(999);
        expect(result).toBeNull();
    });

    it('calculates earnings with 20% commission', async () => {
        prisma.driverProfile.findUnique.mockResolvedValue({
            id: 1, commissionRate: 20,
        });

        prisma.serviceRequest.findMany.mockResolvedValue([
            { id: 10, estimatedPrice: 500, finalPrice: 500, distanceKm: 10, pickupAddress: 'A', dropoffAddress: 'B', createdAt: new Date(), updatedAt: new Date() },
            { id: 11, estimatedPrice: 300, finalPrice: null, distanceKm: 6, pickupAddress: 'C', dropoffAddress: 'D', createdAt: new Date(), updatedAt: new Date() },
        ]);

        prisma.serviceRequest.aggregate.mockResolvedValue({
            _sum: { estimatedPrice: 800, finalPrice: 500 },
            _count: { _all: 2 },
            _avg: { estimatedPrice: 400, distanceKm: 8 },
        });

        const result = await service.getEarningsSummary(1, 'month');

        expect(result).not.toBeNull();
        expect(result!.commissionRate).toBe(20);
        expect(result!.driverSharePercent).toBe(80);
        expect(result!.totalJobs).toBe(2);
        // totalRevenue = finalPrice sum (500), since that's what aggregate returns
        expect(result!.totalRevenue).toBe(500);
        // 500 * 0.80 = 400
        expect(result!.totalEarnings).toBe(400);
        // 500 * 0.20 = 100
        expect(result!.totalCommission).toBe(100);
    });

    it('handles zero completed jobs', async () => {
        prisma.driverProfile.findUnique.mockResolvedValue({
            id: 1, commissionRate: 15,
        });

        prisma.serviceRequest.findMany.mockResolvedValue([]);
        prisma.serviceRequest.aggregate.mockResolvedValue({
            _sum: { estimatedPrice: null, finalPrice: null },
            _count: { _all: 0 },
            _avg: { estimatedPrice: null, distanceKm: null },
        });

        const result = await service.getEarningsSummary(1, 'today');

        expect(result!.totalJobs).toBe(0);
        expect(result!.totalRevenue).toBe(0);
        expect(result!.totalEarnings).toBe(0);
        expect(result!.jobs).toHaveLength(0);
    });

    it('prefers finalPrice over estimatedPrice in per-job breakdown', async () => {
        prisma.driverProfile.findUnique.mockResolvedValue({
            id: 1, commissionRate: 10,
        });

        prisma.serviceRequest.findMany.mockResolvedValue([
            { id: 10, estimatedPrice: 500, finalPrice: 600, distanceKm: 10, pickupAddress: 'A', dropoffAddress: 'B', createdAt: new Date(), updatedAt: new Date() },
        ]);

        prisma.serviceRequest.aggregate.mockResolvedValue({
            _sum: { estimatedPrice: 500, finalPrice: 600 },
            _count: { _all: 1 },
            _avg: { estimatedPrice: 500, distanceKm: 10 },
        });

        const result = await service.getEarningsSummary(1, 'all');

        // Per-job should use finalPrice (600), not estimatedPrice (500)
        expect(result!.jobs[0].revenue).toBe(600);
        // 600 * 0.90 = 540
        expect(result!.jobs[0].earning).toBe(540);
    });
});
