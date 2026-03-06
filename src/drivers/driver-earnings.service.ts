import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Driver Earnings Service
 *
 * Calculates driver earnings from completed jobs based on
 * the commission rate configured on each driver's profile.
 *
 * Revenue model: driver earns (100% - commissionRate%) of the job price.
 * Default commission: 20% (configurable per-driver by admin).
 */
@Injectable()
export class DriverEarningsService {
    private readonly logger = new Logger('DriverEarnings');
    private readonly DEFAULT_COMMISSION_RATE = 20; // Percentage

    constructor(private prisma: PrismaService) { }

    /**
     * Get earnings summary for a driver over a time period.
     */
    async getEarningsSummary(driverProfileId: number, period: 'today' | 'week' | 'month' | 'all' = 'month') {
        const driver = await this.prisma.driverProfile.findUnique({
            where: { id: driverProfileId },
            select: { id: true, commissionRate: true },
        });

        if (!driver) return null;

        const commissionRate = Number(driver.commissionRate ?? this.DEFAULT_COMMISSION_RATE);
        const driverShare = (100 - commissionRate) / 100;

        // Build date filter
        const now = new Date();
        const startDate = new Date();
        if (period === 'today') {
            startDate.setHours(0, 0, 0, 0);
        } else if (period === 'week') {
            startDate.setDate(now.getDate() - 7);
        } else if (period === 'month') {
            startDate.setDate(now.getDate() - 30);
        } else {
            startDate.setFullYear(2020); // all time
        }

        const [deliveredJobs, stats] = await Promise.all([
            this.prisma.serviceRequest.findMany({
                where: {
                    driverId: driverProfileId,
                    status: 'DELIVERED',
                    updatedAt: { gte: startDate },
                },
                select: {
                    id: true,
                    estimatedPrice: true,
                    finalPrice: true,
                    distanceKm: true,
                    pickupAddress: true,
                    dropoffAddress: true,
                    createdAt: true,
                    updatedAt: true,
                },
                orderBy: { updatedAt: 'desc' },
            }),
            this.prisma.serviceRequest.aggregate({
                where: {
                    driverId: driverProfileId,
                    status: 'DELIVERED',
                    updatedAt: { gte: startDate },
                },
                _sum: { estimatedPrice: true, finalPrice: true },
                _count: { _all: true },
                _avg: { estimatedPrice: true, distanceKm: true },
            }),
        ]);

        const totalRevenue = Number(stats._sum.finalPrice ?? stats._sum.estimatedPrice ?? 0);
        const totalEarnings = Math.round(totalRevenue * driverShare * 100) / 100;
        const totalCommission = Math.round(totalRevenue * (commissionRate / 100) * 100) / 100;

        // Per-job earnings breakdown
        const jobEarnings = deliveredJobs.map(job => {
            const jobRevenue = Number(job.finalPrice ?? job.estimatedPrice);
            return {
                jobId: job.id,
                revenue: jobRevenue,
                earning: Math.round(jobRevenue * driverShare * 100) / 100,
                commission: Math.round(jobRevenue * (commissionRate / 100) * 100) / 100,
                distanceKm: Number(job.distanceKm),
                pickupAddress: job.pickupAddress,
                dropoffAddress: job.dropoffAddress,
                completedAt: job.updatedAt,
            };
        });

        return {
            period,
            commissionRate,
            driverSharePercent: 100 - commissionRate,
            totalJobs: stats._count._all,
            totalRevenue,
            totalEarnings,
            totalCommission,
            avgJobRevenue: Number(stats._avg.estimatedPrice ?? 0),
            avgDistanceKm: Number(stats._avg.distanceKm ?? 0),
            jobs: jobEarnings,
        };
    }
}
