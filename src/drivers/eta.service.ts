import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DriverPresenceService } from './driver-presence.service';

/**
 * ETA Service
 *
 * Calculates estimated time of arrival for active jobs
 * based on driver's real-time location from Redis.
 *
 * Uses haversine distance × road factor × average speed.
 */
@Injectable()
export class EtaService {
    private readonly logger = new Logger('EtaService');

    // Average tow truck speeds (km/h) by context
    private readonly SPEEDS = {
        CITY: 25,          // urban, traffic
        HIGHWAY: 60,       // open road
        DEFAULT: 35,       // blended average for Turkey
    };

    private readonly ROAD_FACTOR = 1.35; // haversine → road distance multiplier

    constructor(
        private prisma: PrismaService,
        private presenceService: DriverPresenceService,
    ) { }

    /**
     * Calculate ETA for a specific job.
     * Returns ETA in minutes and distance in km.
     *
     * @param jobId - The job to calculate ETA for
     * @returns { etaMinutes, distanceKm, driverLat, driverLng, calculatedAt } or null
     */
    async calculateEta(jobId: number): Promise<{
        etaMinutes: number;
        distanceKm: number;
        driverLat: number;
        driverLng: number;
        targetLat: number;
        targetLng: number;
        targetType: 'PICKUP' | 'DROPOFF';
        calculatedAt: string;
    } | null> {
        const job = await this.prisma.serviceRequest.findUnique({
            where: { id: jobId },
        });

        if (!job || !job.driverId) return null;

        // Get driver's live location from Redis
        const driverLoc = await this.presenceService.getDriverLocation(job.driverId);
        if (!driverLoc) return null;

        // Determine target: pickup if en route, dropoff if loaded
        let targetLat: number, targetLng: number;
        let targetType: 'PICKUP' | 'DROPOFF';

        if (['ASSIGNED', 'EN_ROUTE_TO_PICKUP'].includes(job.status)) {
            targetLat = Number(job.pickupLat);
            targetLng = Number(job.pickupLng);
            targetType = 'PICKUP';
        } else if (['LOADED', 'EN_ROUTE_TO_DROPOFF'].includes(job.status)) {
            targetLat = Number(job.dropoffLat);
            targetLng = Number(job.dropoffLng);
            targetType = 'DROPOFF';
        } else {
            return null; // No ETA for other statuses
        }

        if (!targetLat || !targetLng) return null;

        // Calculate distance using haversine × road factor
        const straightLineKm = this.haversineKm(driverLoc.lat, driverLoc.lng, targetLat, targetLng);
        const roadDistanceKm = Math.round(straightLineKm * this.ROAD_FACTOR * 10) / 10;

        // Calculate ETA using average speed
        const speedKmH = this.SPEEDS.DEFAULT;
        const etaMinutes = Math.max(Math.round((roadDistanceKm / speedKmH) * 60), 1);

        return {
            etaMinutes,
            distanceKm: roadDistanceKm,
            driverLat: driverLoc.lat,
            driverLng: driverLoc.lng,
            targetLat,
            targetLng,
            targetType,
            calculatedAt: new Date().toISOString(),
        };
    }

    /**
     * Calculate ETA for all active jobs (for admin dashboard).
     */
    async calculateAllActiveEtas() {
        const activeJobs = await this.prisma.serviceRequest.findMany({
            where: {
                status: { in: ['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'LOADED', 'EN_ROUTE_TO_DROPOFF'] },
                driverId: { not: null },
            },
            select: { id: true },
        });

        const etas = await Promise.all(
            activeJobs.map(async (job) => {
                const eta = await this.calculateEta(job.id);
                return eta ? { jobId: job.id, ...eta } : null;
            }),
        );

        return etas.filter(Boolean);
    }

    private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
