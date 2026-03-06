import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DriverPresenceService } from '../drivers/driver-presence.service';
import { RedisService } from '../redis/redis.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * ═══════════════════════════════════════════════════════════════
 *  Wave Dispatch — State Machine
 * ═══════════════════════════════════════════════════════════════
 *
 *  Job status MATCHING → startDispatch()
 *    │
 *    ├─ Wave 1: top 3 within 6 km  → 12s timeout
 *    │   └─ no accept? → expire offers, advance
 *    ├─ Wave 2: top 10 within 10 km → 12s timeout
 *    │   └─ no accept? → expire offers, advance
 *    ├─ Wave 3: top 20 within 20 km → 12s timeout
 *    │   └─ no accept? → expire offers, advance
 *    └─ Wave 4: all within 30 km (public board) → 60s timeout
 *        └─ no accept? → job → NO_DRIVER_FOUND
 *
 *  At ANY wave, if a driver accepts:
 *    → first-accept-wins (Prisma transaction)
 *    → cancel all PENDING offers for this job
 *    → emit driver:job_offer_canceled to all other drivers
 *    → clear wave timer
 *    → job → ASSIGNED
 *
 *  Redis locks: lock:dispatch:{jobId}:{wave}  TTL=15s
 *    Prevents duplicate wave runs in multi-instance deploys.
 *
 * ═══════════════════════════════════════════════════════════════
 */

interface WaveConfig {
    wave: number;
    radiusKm: number;
    maxDrivers: number;
    timeoutMs: number;
}

const WAVE_CONFIG: WaveConfig[] = [
    { wave: 1, radiusKm: 6, maxDrivers: 3, timeoutMs: 12_000 },
    { wave: 2, radiusKm: 10, maxDrivers: 10, timeoutMs: 12_000 },
    { wave: 3, radiusKm: 20, maxDrivers: 20, timeoutMs: 12_000 },
    { wave: 4, radiusKm: 30, maxDrivers: 999, timeoutMs: 60_000 },
];

@Injectable()
export class WaveDispatchService implements OnModuleDestroy {
    private readonly logger = new Logger('WaveDispatch');

    // In-memory timer map: jobId → timer handle (cleared on accept/cancel/destroy)
    private waveTimers = new Map<number, NodeJS.Timeout>();

    constructor(
        private prisma: PrismaService,
        private presenceService: DriverPresenceService,
        private redis: RedisService,
        private realtimeGateway: RealtimeGateway,
    ) { }

    onModuleDestroy() {
        // Clear all pending timers on shutdown
        for (const [jobId, timer] of this.waveTimers) {
            clearTimeout(timer);
            this.logger.warn(`Cleared timer for job #${jobId} on shutdown`);
        }
        this.waveTimers.clear();
    }

    // ─── Public API ───

    /**
     * Entry point: start wave dispatch for a MATCHING job.
     * Called from JobsService after payment confirmation.
     */
    async startDispatch(jobId: number): Promise<void> {
        const job = await this.prisma.serviceRequest.findUnique({ where: { id: jobId } });
        if (!job || job.status !== 'MATCHING') {
            this.logger.warn(`startDispatch: Job #${jobId} not found or not MATCHING — skipping`);
            return;
        }

        // Mark dispatch start time
        await this.prisma.serviceRequest.update({
            where: { id: jobId },
            data: { dispatchStartedAt: new Date(), currentWave: 1 },
        });

        this.logger.log(`🚀 Starting wave dispatch for job #${jobId}`);
        await this.runWave(jobId, 1);
    }

    /**
     * Called when a driver accepts a job.
     * Cancels all PENDING offers and clears timers.
     */
    async onJobAccepted(jobId: number, acceptedDriverId: number): Promise<void> {
        this.clearTimer(jobId);

        // Cancel all remaining PENDING offers for this job
        const pendingOffers = await this.prisma.jobOffer.findMany({
            where: { jobId, status: 'PENDING' },
        });

        if (pendingOffers.length > 0) {
            await this.prisma.jobOffer.updateMany({
                where: { jobId, status: 'PENDING' },
                data: { status: 'CANCELED' },
            });

            // Emit cancellation to each affected driver (except the one who accepted)
            for (const offer of pendingOffers) {
                if (offer.driverId !== acceptedDriverId) {
                    this.realtimeGateway.notifyDriver(offer.driverId, 'driver:job_offer_canceled', {
                        offerId: offer.id,
                        jobId,
                        reason: 'accepted_by_other',
                    });
                }
            }
        }

        // Mark the accepted offer
        await this.prisma.jobOffer.updateMany({
            where: { jobId, driverId: acceptedDriverId, status: 'PENDING' },
            data: { status: 'ACCEPTED', respondedAt: new Date() },
        });

        this.logger.log(`✅ Job #${jobId} accepted by driver #${acceptedDriverId} — ${pendingOffers.length} offers canceled`);
    }

    /**
     * Called when a job is canceled.
     * Cancels all PENDING offers and clears timers.
     */
    async onJobCanceled(jobId: number): Promise<void> {
        this.clearTimer(jobId);

        const pendingOffers = await this.prisma.jobOffer.findMany({
            where: { jobId, status: 'PENDING' },
        });

        if (pendingOffers.length > 0) {
            await this.prisma.jobOffer.updateMany({
                where: { jobId, status: 'PENDING' },
                data: { status: 'CANCELED' },
            });

            for (const offer of pendingOffers) {
                this.realtimeGateway.notifyDriver(offer.driverId, 'driver:job_offer_canceled', {
                    offerId: offer.id,
                    jobId,
                    reason: 'job_canceled',
                });
            }
        }

        this.logger.log(`❌ Job #${jobId} canceled — ${pendingOffers.length} offers canceled`);
    }

    /**
     * Validate an offer for acceptance.
     * Returns the offer if valid, throws otherwise.
     */
    async validateOfferForAccept(offerId: number, driverProfileId: number): Promise<{ jobId: number }> {
        const offer = await this.prisma.jobOffer.findUnique({ where: { id: offerId } });
        if (!offer) throw new Error('OFFER_NOT_FOUND');
        if (offer.driverId !== driverProfileId) throw new Error('OFFER_NOT_YOURS');
        if (offer.status !== 'PENDING') throw new Error('OFFER_NOT_PENDING');
        if (new Date() > offer.expiresAt) throw new Error('OFFER_EXPIRED');

        // Verify job is still MATCHING
        const job = await this.prisma.serviceRequest.findUnique({ where: { id: offer.jobId } });
        if (!job || job.status !== 'MATCHING') throw new Error('JOB_NOT_AVAILABLE');

        return { jobId: offer.jobId };
    }

    /**
     * Dispatch metrics for admin dashboard.
     */
    async getMetrics(since?: Date) {
        const whereClause = since ? { sentAt: { gte: since } } : {};

        const totalOffers = await this.prisma.jobOffer.count({ where: whereClause });
        const acceptedOffers = await this.prisma.jobOffer.count({
            where: { ...whereClause, status: 'ACCEPTED' },
        });
        const expiredOffers = await this.prisma.jobOffer.count({
            where: { ...whereClause, status: 'EXPIRED' },
        });

        // Average time to assign (for accepted offers with respondedAt)
        const avgResult = await this.prisma.$queryRaw<{ avg_ms: number }[]>`
            SELECT AVG(EXTRACT(EPOCH FROM ("respondedAt" - "sentAt")) * 1000) as avg_ms
            FROM "JobOffer"
            WHERE status = 'ACCEPTED' AND "respondedAt" IS NOT NULL
            ${since ? this.prisma.$queryRaw`AND "sentAt" >= ${since}` : this.prisma.$queryRaw``}
        `;

        // Wave accept rates
        const waveStats = await this.prisma.jobOffer.groupBy({
            by: ['wave'],
            _count: { id: true },
            where: { ...whereClause, status: 'ACCEPTED' },
        });

        // No-driver-found rate
        const totalDispatched = await this.prisma.serviceRequest.count({
            where: { dispatchStartedAt: { not: null }, ...(since ? { dispatchStartedAt: { gte: since } } : {}) },
        });
        const noDriverCount = await this.prisma.serviceRequest.count({
            where: { status: 'NO_DRIVER_FOUND', ...(since ? { dispatchStartedAt: { gte: since } } : {}) },
        });

        return {
            totalOffers,
            acceptedOffers,
            expiredOffers,
            wave_accept_rate: waveStats.reduce((acc, w) => {
                acc[`wave_${w.wave}`] = w._count.id;
                return acc;
            }, {} as Record<string, number>),
            time_to_assign_avg_ms: avgResult[0]?.avg_ms || null,
            no_match_rate: totalDispatched > 0 ? (noDriverCount / totalDispatched) : 0,
        };
    }

    // ─── Internal: Wave Execution ───

    private async runWave(jobId: number, waveNum: number): Promise<void> {
        const config = WAVE_CONFIG.find(w => w.wave === waveNum);
        if (!config) {
            this.logger.warn(`No config for wave ${waveNum} — marking NO_DRIVER_FOUND`);
            await this.markNoDriverFound(jobId);
            return;
        }

        // Acquire Redis lock to prevent duplicate wave execution
        const lockKey = `lock:dispatch:${jobId}:${waveNum}`;
        const locked = await this.redis.acquireLock(lockKey, 15);
        if (!locked) {
            this.logger.warn(`Wave ${waveNum} for job #${jobId} — lock not acquired, skipping`);
            return;
        }

        try {
            // Re-check job is still MATCHING
            const job = await this.prisma.serviceRequest.findUnique({ where: { id: jobId } });
            if (!job || job.status !== 'MATCHING') {
                this.logger.log(`Wave ${waveNum} for job #${jobId}: job no longer MATCHING (${job?.status})`);
                return;
            }

            // Update currentWave
            await this.prisma.serviceRequest.update({
                where: { id: jobId },
                data: { currentWave: waveNum },
            });

            this.logger.log(`📡 Wave ${waveNum} for job #${jobId}: radius=${config.radiusKm}km, max=${config.maxDrivers}`);

            // Find candidates via PostGIS + Redis freshness
            const candidates = await this.findCandidates(jobId, job, config);

            if (candidates.length === 0) {
                this.logger.log(`Wave ${waveNum} for job #${jobId}: 0 candidates → advancing`);
                this.scheduleNextWave(jobId, waveNum, 2000); // Short delay before next wave
                return;
            }

            // Create offers (idempotent — skipDuplicates handles reruns)
            const expiresAt = new Date(Date.now() + config.timeoutMs);
            const created = await this.createOffers(jobId, candidates, waveNum, expiresAt);

            // Emit to each driver
            const jobPayload = this.buildJobPayload(job);
            for (const offer of created) {
                this.realtimeGateway.notifyDriver(offer.driverId, 'driver:job_offer', {
                    offerId: offer.id,
                    jobId,
                    wave: waveNum,
                    expiresAt: expiresAt.toISOString(),
                    job: jobPayload,
                });
            }

            this.logger.log(`Wave ${waveNum} for job #${jobId}: ${created.length} offers sent`);

            // Schedule expiry handler
            this.scheduleExpiry(jobId, waveNum, config.timeoutMs);
        } finally {
            await this.redis.releaseLock(lockKey);
        }
    }

    private async findCandidates(
        jobId: number,
        job: any,
        config: WaveConfig,
    ): Promise<{ driverId: number; distanceKm: number }[]> {
        const radiusMeters = config.radiusKm * 1000;

        // Haversine spatial query on currentLat/currentLng
        const dbCandidates = await this.prisma.$queryRaw<{ id: number }[]>`
            SELECT id
            FROM "DriverProfile"
            WHERE "isOnline" = true
              AND "isActive" = true
              AND "currentLat" IS NOT NULL
              AND "currentLng" IS NOT NULL
              AND (
                    6371000 * acos(
                        LEAST(1.0, cos(radians(${Number(job.pickupLat)})) * cos(radians(CAST("currentLat" AS double precision)))
                        * cos(radians(CAST("currentLng" AS double precision)) - radians(${Number(job.pickupLng)}))
                        + sin(radians(${Number(job.pickupLat)})) * sin(radians(CAST("currentLat" AS double precision))))
                    )
                  ) <= ${radiusMeters}
        `;

        // Get existing offers for this job (to exclude already-offered drivers)
        const existingOffers = await this.prisma.jobOffer.findMany({
            where: { jobId },
            select: { driverId: true },
        });
        const alreadyOffered = new Set(existingOffers.map(o => o.driverId));

        // Redis freshness filter + distance calculation
        const results: { driverId: number; distanceKm: number }[] = [];
        for (const candidate of dbCandidates) {
            if (alreadyOffered.has(candidate.id)) continue;

            const loc = await this.presenceService.getDriverLocation(candidate.id);
            if (!loc || (Date.now() - loc.ts > 45_000)) continue; // stale

            // Haversine distance from driver to pickup
            const dist = haversineKm(
                loc.lat, loc.lng,
                Number(job.pickupLat), Number(job.pickupLng),
            );

            if (dist <= config.radiusKm) {
                results.push({ driverId: candidate.id, distanceKm: Math.round(dist * 10) / 10 });
            }
        }

        // Sort by distance, take top N
        results.sort((a, b) => a.distanceKm - b.distanceKm);
        return results.slice(0, config.maxDrivers);
    }

    private async createOffers(
        jobId: number,
        candidates: { driverId: number }[],
        wave: number,
        expiresAt: Date,
    ) {
        // Use createMany with skipDuplicates for idempotency
        await this.prisma.jobOffer.createMany({
            data: candidates.map(c => ({
                jobId,
                driverId: c.driverId,
                wave,
                expiresAt,
                status: 'PENDING' as const,
            })),
            skipDuplicates: true,
        });

        // Fetch the created offers (we need their IDs for the socket payload)
        return this.prisma.jobOffer.findMany({
            where: { jobId, wave, status: 'PENDING' },
        });
    }

    private buildJobPayload(job: any) {
        const requiresFlatbed =
            job.isDrivable === 'NOT_DRIVABLE' &&
            (job.transmissionType === 'AUTOMATIC' || job.steeringWorks === false);

        return {
            pickupAddress: job.pickupAddress,
            dropoffAddress: job.dropoffAddress,
            estimatedPrice: job.estimatedPrice,
            distanceKm: job.distanceKm,
            vehicleType: job.vehicleType,
            isDrivable: job.isDrivable,
            transmissionType: job.transmissionType,
            steeringWorks: job.steeringWorks,
            issueCategory: job.issueCategory,
            customerNotes: job.customerNotes,
            vehiclePlate: job.vehiclePlate,
            vehicleBrand: job.vehicleBrand,
            requiresFlatbed,
        };
    }

    // ─── Timers ───

    private scheduleExpiry(jobId: number, waveNum: number, timeoutMs: number): void {
        this.clearTimer(jobId);
        const timer = setTimeout(() => this.handleExpiry(jobId, waveNum), timeoutMs);
        this.waveTimers.set(jobId, timer);
    }

    private scheduleNextWave(jobId: number, currentWave: number, delayMs: number): void {
        this.clearTimer(jobId);
        const nextWave = currentWave + 1;
        const timer = setTimeout(() => this.runWave(jobId, nextWave), delayMs);
        this.waveTimers.set(jobId, timer);
    }

    private clearTimer(jobId: number): void {
        const existing = this.waveTimers.get(jobId);
        if (existing) {
            clearTimeout(existing);
            this.waveTimers.delete(jobId);
        }
    }

    private async handleExpiry(jobId: number, waveNum: number): Promise<void> {
        // Acquire lock to prevent double-handling
        const lockKey = `lock:dispatch:${jobId}:expire:${waveNum}`;
        const locked = await this.redis.acquireLock(lockKey, 15);
        if (!locked) return;

        try {
            // Re-check job
            const job = await this.prisma.serviceRequest.findUnique({ where: { id: jobId } });
            if (!job || job.status !== 'MATCHING') return;

            // Expire all PENDING offers from this wave
            const pendingOffers = await this.prisma.jobOffer.findMany({
                where: { jobId, wave: waveNum, status: 'PENDING' },
            });

            if (pendingOffers.length > 0) {
                await this.prisma.jobOffer.updateMany({
                    where: { jobId, wave: waveNum, status: 'PENDING' },
                    data: { status: 'EXPIRED' },
                });

                for (const offer of pendingOffers) {
                    this.realtimeGateway.notifyDriver(offer.driverId, 'driver:job_offer_expired', {
                        offerId: offer.id,
                        jobId,
                    });
                }
            }

            this.logger.log(`⏰ Wave ${waveNum} expired for job #${jobId}: ${pendingOffers.length} offers expired`);

            // Advance to next wave
            const nextWave = waveNum + 1;
            if (nextWave <= WAVE_CONFIG.length) {
                await this.runWave(jobId, nextWave);
            } else {
                await this.markNoDriverFound(jobId);
            }
        } finally {
            await this.redis.releaseLock(lockKey);
        }
    }

    private async markNoDriverFound(jobId: number): Promise<void> {
        this.clearTimer(jobId);

        await this.prisma.serviceRequest.update({
            where: { id: jobId },
            data: { status: 'NO_DRIVER_FOUND' },
        });

        this.realtimeGateway.notifyJobUpdate(jobId, 'job:status_changed', {
            jobId,
            status: 'NO_DRIVER_FOUND',
            notificationText: 'Üzgünüz, yakınlarda uygun çekici bulunamadı. Lütfen tekrar deneyin.',
        });

        this.logger.warn(`⚠️ Job #${jobId} → NO_DRIVER_FOUND after all waves exhausted`);
    }
}

// ─── Haversine ───

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg: number): number {
    return deg * (Math.PI / 180);
}
