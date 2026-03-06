import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { DriverPresenceService } from '../drivers/driver-presence.service';
import { RedisService } from '../redis/redis.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationService } from '../notifications/notification.service';
import { WaveDispatchService } from './wave-dispatch.service';
import { JobStatus, VehicleType, CancelledBy } from '@prisma/client';
import { PAYMENT_PROVIDER, PaymentProvider } from '../payments/providers/payment-provider.interface';

// ── Haversine distance (km) between two lat/lng points ──
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Injectable()
export class JobsService {
    private readonly logger = new Logger('JobsService');

    constructor(
        private prisma: PrismaService,
        private pricingService: PricingService,
        private presenceService: DriverPresenceService,
        private redis: RedisService,
        @Inject(forwardRef(() => RealtimeGateway))
        private realtimeGateway: RealtimeGateway,
        private notificationService: NotificationService,
        private waveDispatchService: WaveDispatchService,
        @Inject(PAYMENT_PROVIDER) private paymentProvider: PaymentProvider,
    ) { }

    // ─── Quote (in-memory — no DB row until payment confirms) ───

    /**
     * Calculate a price quote. Returns an in-memory object.
     * The server recomputes price on payment confirm too, so client can't tamper.
     */
    async calculateQuote(data: any) {
        // Server-side distance computation (same as createJobFromPayment)
        let distanceKm: number;
        const pLat = Number(data.pickupLat);
        const pLng = Number(data.pickupLng);
        const dLat = Number(data.dropoffLat);
        const dLng = Number(data.dropoffLng);

        if (pLat && pLng && dLat && dLng) {
            distanceKm = Math.round(haversineKm(pLat, pLng, dLat, dLng) * 1.35 * 10) / 10;
            distanceKm = Math.max(distanceKm, 1);
        } else {
            distanceKm = Number(data.distanceKm) || 10; // fallback only
            console.warn(`⚠️ [Quote] Missing lat/lng — using fallback distance: ${distanceKm} km`);
        }

        const durationMin = Math.max(Number(data.durationMin) || Math.round(distanceKm * 1.5), 5);
        const quote = await this.pricingService.calculateQuote(distanceKm, durationMin, data.vehicleType);

        return {
            pickupAddress: data.pickupAddress,
            dropoffAddress: data.dropoffAddress,
            pickupLat: data.pickupLat,
            pickupLng: data.pickupLng,
            dropoffLat: data.dropoffLat,
            dropoffLng: data.dropoffLng,
            pickupPlaceId: data.pickupPlaceId,
            dropoffPlaceId: data.dropoffPlaceId,
            routePolyline: data.routePolyline,
            vehicleType: data.vehicleType,
            distanceKm,
            durationMin,
            estimatedPrice: quote.finalPrice,
            breakdown: quote,
        };
    }

    /**
     * Create a Job in PENDING_PAYMENT status (Quote-then-Pay model).
     * 
     * Called when the customer confirms a quote but payment hasn't been captured yet.
     * The job record serves as the single source of truth during the payment flow.
     * 
     * After payment confirms → PaymentsService transitions to MATCHING and calls dispatchJob().
     */
    async createQuoteJob(data: {
        customerId?: number | null;
        guestName?: string | null;
        guestPhone?: string | null;
        guestEmail?: string | null;
        pickupAddress: string;
        dropoffAddress: string;
        pickupLat?: any;
        pickupLng?: any;
        dropoffLat?: any;
        dropoffLng?: any;
        pickupPlaceId?: string;
        dropoffPlaceId?: string;
        routePolyline?: string;
        vehicleType: string;
        distanceKm?: number;
        durationMin?: number;
        isDrivable?: string;
        transmissionType?: string;
        steeringWorks?: boolean;
        issueCategory?: string;
        customerNotes?: string;
        vehiclePlate?: string;
        vehicleBrand?: string;
        vehicleModel?: string;
    }) {
        // Server-side distance recomputation (never trust client)
        let distanceKm: number;
        const pLat = Number(data.pickupLat);
        const pLng = Number(data.pickupLng);
        const dLat = Number(data.dropoffLat);
        const dLng = Number(data.dropoffLng);

        if (pLat && pLng && dLat && dLng) {
            distanceKm = Math.round(haversineKm(pLat, pLng, dLat, dLng) * 1.35 * 10) / 10;
            distanceKm = Math.max(distanceKm, 1);
        } else {
            distanceKm = 10;
            console.warn(`⚠️ [Jobs] Missing lat/lng — using fallback distance: ${distanceKm} km`);
        }

        const durationMin = Math.max(Number(data.durationMin) || Math.round(distanceKm * 1.5), 5);
        const quote = await this.pricingService.calculateQuote(distanceKm, durationMin, data.vehicleType);

        const job = await this.prisma.serviceRequest.create({
            data: {
                customerId: data.customerId || null,
                guestName: data.guestName || null,
                guestPhone: data.guestPhone || null,
                guestEmail: data.guestEmail || null,
                pickupAddress: data.pickupAddress,
                dropoffAddress: data.dropoffAddress,
                pickupLat: data.pickupLat,
                pickupLng: data.pickupLng,
                dropoffLat: data.dropoffLat,
                dropoffLng: data.dropoffLng,
                pickupPlaceId: data.pickupPlaceId || null,
                dropoffPlaceId: data.dropoffPlaceId || null,
                routePolyline: data.routePolyline || null,
                durationMin,
                vehicleType: data.vehicleType as VehicleType,
                distanceKm,
                estimatedPrice: quote.finalPrice,
                status: 'PENDING_PAYMENT',
                isDrivable: data.isDrivable as any || undefined,
                transmissionType: data.transmissionType as any || undefined,
                steeringWorks: data.steeringWorks ?? undefined,
                issueCategory: data.issueCategory as any || undefined,
                customerNotes: data.customerNotes || undefined,
                vehiclePlate: data.vehiclePlate || undefined,
                vehicleBrand: data.vehicleBrand || undefined,
                vehicleModel: data.vehicleModel || undefined,
            },
        });

        console.log(`📋 [Jobs] Job #${job.id} created (PENDING_PAYMENT) — price: ${quote.finalPrice} TRY`);

        // Notify admin of new quote/pending job
        this.realtimeGateway.notifyAdmin('job:created', { jobId: job.id, job, status: 'PENDING_PAYMENT' });

        return job;
    }

    /**
     * Create a Job ONLY after payment is confirmed.
     * Server recomputes price to prevent client tampering.
     * Returns the persisted ServiceRequest + dispatches to drivers.
     */
    async createJobFromPayment(data: {
        customerId?: number | null;
        guestName?: string;
        guestPhone?: string;
        guestEmail?: string;
        pickupAddress: string;
        dropoffAddress: string;
        pickupLat?: any;
        pickupLng?: any;
        dropoffLat?: any;
        dropoffLng?: any;
        pickupPlaceId?: string;
        dropoffPlaceId?: string;
        routePolyline?: string;
        vehicleType: string;
        distanceKm?: number;  // client value — ignored, recomputed server-side
        durationMin?: number;
        // Vehicle condition
        isDrivable?: string;
        transmissionType?: string;
        steeringWorks?: boolean;
        issueCategory?: string;
        customerNotes?: string;
        vehiclePlate?: string;
        vehicleBrand?: string;
        vehicleModel?: string;
    }, idempotencyKey?: string) {
        // ── Idempotency: if key provided, check for existing job ──
        if (idempotencyKey) {
            const existingPayment = await this.prisma.payment.findUnique({
                where: { providerPaymentId: idempotencyKey },
                include: { job: true },
            });
            if (existingPayment?.job) {
                console.log(`⚡ [Jobs] Idempotent hit — returning existing job #${existingPayment.job.id} for key: ${idempotencyKey}`);
                return existingPayment.job;
            }
        }

        // ── Server-side distance recomputation (never trust client distance/price) ──
        let distanceKm: number;
        const pLat = Number(data.pickupLat);
        const pLng = Number(data.pickupLng);
        const dLat = Number(data.dropoffLat);
        const dLng = Number(data.dropoffLng);

        if (pLat && pLng && dLat && dLng) {
            // Haversine gives straight-line; multiply by 1.35 for road approximation
            distanceKm = Math.round(haversineKm(pLat, pLng, dLat, dLng) * 1.35 * 10) / 10;
            distanceKm = Math.max(distanceKm, 1); // minimum 1 km
            console.log(`📏 [Jobs] Server-computed distance: ${distanceKm} km (haversine × 1.35)`);
        } else {
            distanceKm = 10; // fallback — should not happen in production
            console.warn(`⚠️ [Jobs] Missing lat/lng — using fallback distance: ${distanceKm} km`);
        }

        const durationMin = Math.max(Number(data.durationMin) || Math.round(distanceKm * 1.5), 5);

        // Server-side price recomputation (never trust client price)
        const quote = await this.pricingService.calculateQuote(distanceKm, durationMin, data.vehicleType);

        const job = await this.prisma.serviceRequest.create({
            data: {
                customerId: data.customerId || null,
                guestName: data.guestName || null,
                guestPhone: data.guestPhone || null,
                guestEmail: data.guestEmail || null,
                pickupAddress: data.pickupAddress,
                dropoffAddress: data.dropoffAddress,
                pickupLat: data.pickupLat,
                pickupLng: data.pickupLng,
                dropoffLat: data.dropoffLat,
                dropoffLng: data.dropoffLng,
                pickupPlaceId: data.pickupPlaceId || null,
                dropoffPlaceId: data.dropoffPlaceId || null,
                routePolyline: data.routePolyline || null,
                durationMin,
                vehicleType: data.vehicleType as VehicleType,
                distanceKm,
                estimatedPrice: quote.finalPrice,
                status: 'MATCHING',
                // Vehicle condition fields
                isDrivable: data.isDrivable as any || undefined,
                transmissionType: data.transmissionType as any || undefined,
                steeringWorks: data.steeringWorks ?? undefined,
                issueCategory: data.issueCategory as any || undefined,
                customerNotes: data.customerNotes || undefined,
                vehiclePlate: data.vehiclePlate || undefined,
                vehicleBrand: data.vehicleBrand || undefined,
                vehicleModel: data.vehicleModel || undefined,
            },
        });

        console.log(`✅ [Jobs] Job #${job.id} created (MATCHING) — price: ${quote.finalPrice} TRY`);

        // Notify admin of new job
        this.realtimeGateway.notifyAdmin('job:created', { jobId: job.id, job });

        // Immediately dispatch to nearby drivers
        const dispatchResult = await this.dispatchJob(job.id);
        console.log(`[Jobs] Job #${job.id} dispatch result:`, dispatchResult);

        return job;
    }

    /**
     * Get job by ID (no ownership check — caller must validate access).
     */
    async getJobById(id: number) {
        return this.prisma.serviceRequest.findUnique({
            where: { id },
            include: {
                driver: {
                    select: {
                        id: true,
                        user: {
                            select: { firstName: true, lastName: true, phone: true },
                        },
                        licenseNumber: true,
                    },
                },
            },
        });
    }

    /**
     * Dispatch a job using wave-based targeted offers.
     * Delegates to WaveDispatchService.
     */
    async dispatchJob(jobId: number) {
        const job = await this.prisma.serviceRequest.findUnique({ where: { id: jobId } });
        if (!job) return { dispatched: false, count: 0, status: null };

        if (job.status !== 'MATCHING') {
            this.logger.log(`[Dispatch] Job ${jobId} status is ${job.status}. Skipping.`);
            return { dispatched: false, count: 0, status: job.status };
        }

        // Delegate to wave dispatch (async — runs waves in background)
        this.waveDispatchService.startDispatch(jobId).catch(err => {
            this.logger.error(`[Dispatch] Wave dispatch failed for job ${jobId}:`, err);
        });

        return { dispatched: true, count: 0, status: 'MATCHING' };
    }

    /**
     * Get nearby driver availability for dynamic ETA on tracking screen.
     * Returns count of eligible drivers and average distance to pickup.
     */
    async getNearbyAvailability(pickupLat: number, pickupLng: number) {
        const radiusMeters = 30000;

        // Haversine: online + active drivers within 30km, with distance
        const candidates = await this.prisma.$queryRaw<
            { id: number; distanceMeters: number }[]
        >`
            SELECT id,
                   (
                       6371000 * acos(
                           LEAST(1.0, cos(radians(${pickupLat})) * cos(radians(CAST("currentLat" AS double precision)))
                           * cos(radians(CAST("currentLng" AS double precision)) - radians(${pickupLng}))
                           + sin(radians(${pickupLat})) * sin(radians(CAST("currentLat" AS double precision))))
                       )
                   ) as "distanceMeters"
            FROM "DriverProfile"
            WHERE "isOnline" = true
              AND "isActive" = true
              AND "currentLat" IS NOT NULL
              AND "currentLng" IS NOT NULL
              AND (
                    6371000 * acos(
                        LEAST(1.0, cos(radians(${pickupLat})) * cos(radians(CAST("currentLat" AS double precision)))
                        * cos(radians(CAST("currentLng" AS double precision)) - radians(${pickupLng}))
                        + sin(radians(${pickupLat})) * sin(radians(CAST("currentLat" AS double precision))))
                    )
                  ) <= ${radiusMeters}
        `;

        // Redis freshness check (< 45s)
        const freshDrivers: { id: number; distanceKm: number }[] = [];
        for (const c of candidates) {
            const loc = await this.presenceService.getDriverLocation(c.id);
            if (loc && (Date.now() - loc.ts < 45000)) {
                freshDrivers.push({
                    id: c.id,
                    distanceKm: Number((c.distanceMeters / 1000).toFixed(1)),
                });
            }
        }

        const count = freshDrivers.length;
        const avgDistanceKm = count > 0
            ? Math.round((freshDrivers.reduce((s, d) => s + d.distanceKm, 0) / count) * 10) / 10
            : 0;

        // Confidence level based on nearby count
        let confidence: 'LOW' | 'MEDIUM' | 'HIGH';
        if (count >= 4) confidence = 'HIGH';
        else if (count >= 2) confidence = 'MEDIUM';
        else confidence = 'LOW';

        return { count, avgDistanceKm, confidence };
    }

    /**
     * Get jobs available for a driver.
     * Only returns jobs that have reached Wave 4 (public board).
     * Waves 1-3 are private — delivered via socket only.
     */
    async getNearbyJobs(driverId: number, lat: number, lng: number) {
        const radiusMeters = 30000;

        const jobs = await this.prisma.$queryRaw<any[]>`
            SELECT 
                id, 
                "pickupAddress", 
                "dropoffAddress", 
                "estimatedPrice", 
                "distanceKm" as "jobDistanceKm",
                "vehicleType",
                "isDrivable",
                "transmissionType",
                "steeringWorks",
                "issueCategory",
                "customerNotes",
                "vehiclePlate",
                "vehicleBrand",
                "pickupLat",
                "pickupLng",
                "dropoffLat",
                "dropoffLng",
                (
                    6371000 * acos(
                        LEAST(1.0, cos(radians(CAST("pickupLat" AS double precision))) * cos(radians(${lat}))
                        * cos(radians(${lng}) - radians(CAST("pickupLng" AS double precision)))
                        + sin(radians(CAST("pickupLat" AS double precision))) * sin(radians(${lat})))
                    )
                ) as "pickupDistanceMeters"
            FROM "ServiceRequest"
            WHERE status = 'MATCHING'
              AND "currentWave" >= 4
              AND "pickupLat" IS NOT NULL
              AND "pickupLng" IS NOT NULL
              AND (
                    6371000 * acos(
                        LEAST(1.0, cos(radians(CAST("pickupLat" AS double precision))) * cos(radians(${lat}))
                        * cos(radians(${lng}) - radians(CAST("pickupLng" AS double precision)))
                        + sin(radians(CAST("pickupLat" AS double precision))) * sin(radians(${lat})))
                    )
                  ) <= ${radiusMeters}
        `;

        // Determine tow type based on vehicle condition
        const getTowType = (j: any): string => {
            if (j.isDrivable === 'NOT_DRIVABLE') {
                if (j.transmissionType === 'AUTOMATIC' || j.steeringWorks === false) {
                    return 'FLATBED';
                }
                return 'STANDARD';
            }
            return 'STANDARD';
        };

        // Format for Driver App
        return jobs.map((j: any) => ({
            id: j.id,
            pickupAddress: j.pickupAddress,
            dropoffAddress: j.dropoffAddress,
            driverEarning: Number(j.estimatedPrice) * 0.8, // 20% commission
            pickupDistanceKm: (j.pickupDistanceMeters / 1000).toFixed(1),
            jobDistanceKm: Number(j.jobDistanceKm),
            vehicleType: j.vehicleType,
            // Vehicle condition
            isDrivable: j.isDrivable || 'UNKNOWN',
            transmissionType: j.transmissionType || 'UNKNOWN',
            steeringWorks: j.steeringWorks,
            issueCategory: j.issueCategory || null,
            customerNotes: j.customerNotes || null,
            vehiclePlate: j.vehiclePlate || null,
            vehicleBrand: j.vehicleBrand || null,
            towType: getTowType(j),
            // Coordinates for client-side use
            pickupLat: j.pickupLat ? Number(j.pickupLat) : null,
            pickupLng: j.pickupLng ? Number(j.pickupLng) : null,
            dropoffLat: j.dropoffLat ? Number(j.dropoffLat) : null,
            dropoffLng: j.dropoffLng ? Number(j.dropoffLng) : null,
        }));
    }

    /**
     * Atomic Accept Job (First accept wins)
     * Optionally validates an offerId if provided.
     */
    async acceptJob(driverProfileId: number, jobId: number, offerId?: number) {
        // If offerId is provided, validate the offer first
        if (offerId) {
            try {
                await this.waveDispatchService.validateOfferForAccept(offerId, driverProfileId);
            } catch (err: any) {
                if (err.message === 'OFFER_NOT_FOUND') throw new NotFoundException('Offer not found');
                if (err.message === 'OFFER_NOT_YOURS') throw new ForbiddenException('This offer is not for you');
                if (err.message === 'OFFER_NOT_PENDING') throw new ConflictException('Offer already responded');
                if (err.message === 'OFFER_EXPIRED') throw new BadRequestException('Offer has expired');
                if (err.message === 'JOB_NOT_AVAILABLE') throw new ConflictException('Job no longer available');
                throw err;
            }
        }

        // Idempotency & Race Condition handling via Transaction
        const updatedJob = await this.prisma.$transaction(async (tx) => {
            // First check if I already have it (Idempotent)
            const existing = await tx.serviceRequest.findUnique({ where: { id: jobId } });
            if (!existing) throw new NotFoundException('Job not found');

            if (existing.driverId === driverProfileId && existing.status === 'ASSIGNED') {
                return existing; // Already mine, 200 OK
            }

            // Attempt to claim (atomic: only one driver wins)
            const result = await tx.serviceRequest.updateMany({
                where: {
                    id: jobId,
                    status: 'MATCHING'
                },
                data: {
                    status: 'ASSIGNED',
                    driverId: driverProfileId
                }
            });

            if (result.count === 0) {
                throw new Error('JOB_TAKEN');
            }

            // Fetch with driver details for the socket payload
            const job = await tx.serviceRequest.findUnique({
                where: { id: jobId },
                include: {
                    driver: {
                        select: {
                            id: true,
                            user: { select: { firstName: true, lastName: true, phone: true } },
                            licenseNumber: true,
                        },
                    },
                },
            });
            return job!;
        }).catch((err) => {
            if (err.message === 'JOB_TAKEN') {
                throw new ConflictException('Job already taken');
            }
            throw err;
        });

        // ── Cancel all other pending offers for this job ──
        await this.waveDispatchService.onJobAccepted(jobId, driverProfileId);

        // ── Set Redis activeJob mapping (enables zero-DB location relay) ──
        await this.presenceService.setDriverBusy(driverProfileId, jobId);
        await this.presenceService.setDriverActiveJob(driverProfileId, jobId);

        // ── Emit real-time update to customer (job room) + admin ──
        this.logger.log(`Job #${jobId} accepted by driver #${driverProfileId} → emitting job:status_changed`);
        this.realtimeGateway.notifyJobUpdate(jobId, 'job:status_changed', {
            jobId,
            status: 'ASSIGNED',
            driver: (updatedJob as any).driver || null,
        });

        return updatedJob;
    }

    // ── Decline (no-op for wave dispatch — offer auto-expires) ──

    async declineJob(driverProfileId: number, jobId: number) {
        // With wave dispatch, declining is a no-op — offers auto-expire.
        // Driver simply doesn't accept within the 12s window.
        this.logger.log(`Driver #${driverProfileId} declined job #${jobId} — offer will auto-expire`);
        return { status: 'declined', jobId };
    }

    // ─── Queries ───

    async findAll(userId: number) {
        return this.prisma.serviceRequest.findMany({
            where: { customerId: userId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findAllAdmin(filters?: { status?: JobStatus }) {
        const where: any = {};
        if (filters?.status) where.status = filters.status;

        return this.prisma.serviceRequest.findMany({
            where,
            include: {
                customer: { select: { id: true, email: true, phone: true } },
                driver: { select: { id: true, userId: true, licenseNumber: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findOne(userId: number, id: number, isAdmin = false) {
        const job = await this.prisma.serviceRequest.findUnique({ where: { id } });
        if (!job) throw new NotFoundException('Job not found');

        if (!isAdmin && job.customerId !== userId) {
            throw new ForbiddenException('Access denied');
        }
        return job;
    }

    async updateStatus(userId: number, id: number, status: JobStatus, isAdmin = false) {
        const job = await this.prisma.serviceRequest.findUnique({ where: { id } });
        if (!job) throw new NotFoundException('Job not found');

        if (!isAdmin && job.customerId !== userId) {
            throw new ForbiddenException('Access denied');
        }

        if (status === 'CANCELED' && ['DELIVERED', 'EN_ROUTE_TO_DROPOFF'].includes(job.status)) {
            throw new ForbiddenException('Cannot cancel job in transit to delivery');
        }

        // If delivered or canceled, free the driver
        if (['DELIVERED', 'CANCELED'].includes(status) && job.driverId) {
            await this.presenceService.setDriverAvailable(job.driverId);
        }

        const updatedJob = await this.prisma.serviceRequest.update({
            where: { id },
            data: { status },
        });

        this.realtimeGateway.notifyJobUpdate(id, 'job:status_changed', { jobId: id, status });
        return updatedJob;
    }

    async getActiveJobs() {
        return this.prisma.serviceRequest.findMany({
            where: {
                status: {
                    in: [
                        'MATCHING',
                        'ASSIGNED',
                        'EN_ROUTE_TO_PICKUP',
                        'LOADED',
                        'EN_ROUTE_TO_DROPOFF',
                    ],
                },
            },
            include: {
                customer: { select: { id: true, email: true, phone: true } },
                driver: { select: { id: true, userId: true, licenseNumber: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
    async getDashboardStats(period: 'today' | 'week' | 'month') {
        const now = new Date();
        const startDate = new Date();

        if (period === 'today') {
            startDate.setHours(0, 0, 0, 0);
        } else if (period === 'week') {
            startDate.setDate(now.getDate() - 7);
        } else if (period === 'month') {
            startDate.setDate(now.getDate() - 30);
        }

        const where: any = {
            createdAt: { gte: startDate },
        };

        const [counts, avgStats, revenueStats] = await Promise.all([
            // Counts by status
            this.prisma.serviceRequest.groupBy({
                by: ['status'],
                where,
                _count: { _all: true },
            }),
            // Averages for DELIVERED jobs
            this.prisma.serviceRequest.aggregate({
                where: { ...where, status: 'DELIVERED' },
                _avg: { estimatedPrice: true, distanceKm: true },
            }),
            // Total revenue (sum of estimatedPrice for DELIVERED jobs)
            this.prisma.serviceRequest.aggregate({
                where: { ...where, status: 'DELIVERED' },
                _sum: { estimatedPrice: true },
            }),
        ]);

        const stats = {
            totalJobs: 0,
            completedJobs: 0,
            cancelledJobs: 0,
            revenue: revenueStats._sum.estimatedPrice || 0,
            avgPrice: avgStats._avg.estimatedPrice || 0,
            avgDistance: avgStats._avg.distanceKm || 0,
            avgAcceptanceTime: 0,
        };

        counts.forEach(c => {
            stats.totalJobs += c._count._all;
            if (c.status === 'DELIVERED') stats.completedJobs = c._count._all;
            if (c.status === 'CANCELED') stats.cancelledJobs = c._count._all;
        });

        return stats;
    }

    async updateJobStatusByDriver(driverProfileId: number, jobId: number, status: JobStatus) {
        const job = await this.prisma.serviceRequest.findUnique({ where: { id: jobId } });
        if (!job) throw new NotFoundException('Job not found');

        if (job.driverId !== driverProfileId) {
            throw new ForbiddenException('This job is not assigned to you');
        }

        // Validate Transitions
        // ASSIGNED -> EN_ROUTE_TO_PICKUP -> LOADED -> EN_ROUTE_TO_DROPOFF -> DELIVERED

        const validTransitions: Partial<Record<JobStatus, JobStatus[]>> = {
            ASSIGNED: ['EN_ROUTE_TO_PICKUP', 'CANCELED'],
            EN_ROUTE_TO_PICKUP: ['LOADED', 'CANCELED'],
            LOADED: ['EN_ROUTE_TO_DROPOFF', 'CANCELED'],
            EN_ROUTE_TO_DROPOFF: ['DELIVERED'],
        };

        const allowed = validTransitions[job.status] || [];
        if (!allowed.includes(status)) {
            // Allow idempotency
            if (job.status === status) return job;
            throw new BadRequestException(`Invalid status transition from ${job.status} to ${status}`);
        }

        // Rule: Driver cannot CANCEL if EN_ROUTE_TO_DROPOFF (vehicle is loaded, must call support)
        if (status === 'CANCELED' && job.status === 'EN_ROUTE_TO_DROPOFF') {
            throw new ForbiddenException('Cannot cancel while delivering. Contact support.');
        }

        // Update
        const updatedJob = await this.prisma.serviceRequest.update({
            where: { id: jobId },
            data: { status },
            include: {
                driver: {
                    select: {
                        id: true,
                        user: { select: { firstName: true, lastName: true, phone: true } },
                        licenseNumber: true,
                    },
                },
            },
        });

        // Turkish notification messages per status
        const statusMessages: Partial<Record<JobStatus, string>> = {
            EN_ROUTE_TO_PICKUP: 'Çekiniz yola çıktı, yakında aracınızın yanına varacak.',
            LOADED: 'Aracınız çekiciye yüklendi.',
            EN_ROUTE_TO_DROPOFF: 'Aracınız teslim noktasına gidiyor.',
            DELIVERED: 'Aracınız teslim edildi. Teşekkür ederiz!',
        };

        // Emit enriched socket event
        this.realtimeGateway.notifyJobUpdate(jobId, 'job:status_changed', {
            jobId,
            status,
            driver: updatedJob.driver || null,
            notificationText: statusMessages[status] || null,
        });

        // SMS stub for important statuses
        if (statusMessages[status]) {
            console.log('--------------------------------------------------');
            console.log(`📲 [SMS STUB] Job #${jobId}: ${statusMessages[status]}`);
            console.log('--------------------------------------------------');
        }

        // If delivered, free the driver + clear Redis activeJob
        if (status === 'DELIVERED') {
            await this.presenceService.setDriverAvailable(driverProfileId);
            // clearDriverActiveJob is already called inside setDriverAvailable
        }

        // If canceled by driver, also clear activeJob
        if (status === 'CANCELED') {
            await this.presenceService.setDriverAvailable(driverProfileId);
        }

        return updatedJob;
    }

    // ─── Cancel Flow ───

    /**
     * Cancel a job with reason tracking, refund, and notifications.
     *
     * Rules:
     *  - PENDING_PAYMENT, MATCHING: always cancellable (full refund if paid)
     *  - ASSIGNED, EN_ROUTE_TO_PICKUP, LOADED: cancellable (full refund)
     *  - EN_ROUTE_TO_DROPOFF: only ADMIN can cancel (vehicle loaded on truck)
     *  - DELIVERED: not cancellable
     *  - CANCELED: idempotent return
     */
    async cancelJob(jobId: number, cancelledBy: CancelledBy, reason?: string, actorUserId?: number) {
        const job = await this.prisma.serviceRequest.findUnique({
            where: { id: jobId },
            include: { payments: true },
        });

        if (!job) throw new NotFoundException('Job not found');

        // Idempotent: already cancelled
        if (job.status === 'CANCELED') {
            return { success: true, jobId, status: 'CANCELED', message: 'Already cancelled' };
        }

        // Cannot cancel completed jobs
        if (job.status === 'DELIVERED') {
            throw new BadRequestException({
                errorCode: 'CANCEL_DENIED',
                message: 'Teslim edilmiş talepler iptal edilemez.',
            });
        }

        // EN_ROUTE_TO_DROPOFF: only admin can cancel (vehicle loaded on truck)
        if (job.status === 'EN_ROUTE_TO_DROPOFF' && cancelledBy !== 'ADMIN') {
            throw new BadRequestException({
                errorCode: 'CANCEL_DENIED',
                message: 'Araç yüklü durumda, lütfen müşteri hizmetleri ile iletişime geçin.',
            });
        }

        // ── Ownership check for non-admin ──
        if (cancelledBy === 'CUSTOMER' && actorUserId && job.customerId !== actorUserId) {
            throw new ForbiddenException('Bu talebi iptal etme yetkiniz yok.');
        }

        if (cancelledBy === 'DRIVER' && actorUserId) {
            const driverProfile = await this.prisma.driverProfile.findUnique({ where: { userId: actorUserId } });
            if (!driverProfile || job.driverId !== driverProfile.id) {
                throw new ForbiddenException('Bu talep size atanmamış.');
            }
        }

        // ── Update job status ──
        const cancelReason = reason || cancelledBy === 'CUSTOMER' ? `Cancelled by customer` : `Cancelled by ${cancelledBy.toLowerCase()}`;

        const updatedJob = await this.prisma.serviceRequest.update({
            where: { id: jobId },
            data: {
                status: 'CANCELED',
                cancelReason: reason || cancelReason,
                cancelledBy: cancelledBy,
                cancelledAt: new Date(),
            },
        });

        this.logger.log(`❌ Job #${jobId} cancelled by ${cancelledBy}${reason ? ` — reason: ${reason}` : ''}`);

        // ── Free the driver if assigned ──
        if (job.driverId) {
            await this.presenceService.setDriverAvailable(job.driverId);
            // clearDriverActiveJob is already called inside setDriverAvailable
            this.logger.log(`🔓 Driver #${job.driverId} freed from cancelled job #${jobId}`);
        }

        // ── Cancel all pending wave dispatch offers ──
        await this.waveDispatchService.onJobCanceled(jobId);

        // ── Process refund for captured payments ──
        let refundResult = null;
        const capturedPayment = job.payments?.find(p => p.status === 'CAPTURED');
        if (capturedPayment && capturedPayment.providerPaymentId) {
            try {
                refundResult = await this.paymentProvider.refund(
                    capturedPayment.providerPaymentId,
                    Number(capturedPayment.amount),
                );

                if (refundResult.success) {
                    await this.prisma.payment.update({
                        where: { id: capturedPayment.id },
                        data: { status: 'REFUNDED' },
                    });
                    this.logger.log(`💰 Refund processed for payment #${capturedPayment.id} (${capturedPayment.amount} TRY)`);
                } else {
                    this.logger.warn(`⚠️ Refund failed for payment #${capturedPayment.id}: ${refundResult.errorMessage}`);
                }
            } catch (err) {
                this.logger.error(`⚠️ Refund error for payment #${capturedPayment.id}:`, err);
                // Don't fail the cancel — job is still cancelled, refund can be retried manually
            }
        }

        // ── Real-time notifications ──
        this.realtimeGateway.notifyJobUpdate(jobId, 'job:status_changed', {
            jobId,
            status: 'CANCELED',
            cancelledBy,
            notificationText: 'Talebiniz iptal edildi.',
        });

        this.realtimeGateway.notifyAdmin('job:cancelled', {
            jobId,
            cancelledBy,
            cancelReason: reason,
            previousStatus: job.status,
        });

        return {
            success: true,
            jobId,
            status: 'CANCELED',
            cancelledBy,
            cancelReason: reason,
            refund: refundResult ? {
                success: refundResult.success,
                amount: capturedPayment ? Number(capturedPayment.amount) : 0,
            } : null,
        };
    }
}
