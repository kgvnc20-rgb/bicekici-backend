import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  Redis Key Design (DriverPresenceService)
 * ═══════════════════════════════════════════════════════════════
 *
 *  driver:{id}:loc         → JSON { lat, lng, heading, speed, ts, status }   TTL=45s
 *  driver:{id}:meta        → JSON { name, plate, vehicleType, userId, ... }  No TTL
 *  driver:{id}:activeJob   → string(jobId)                                   No TTL (cleared on terminal status)
 *  driver:{id}:lastPersist → string(unixMs)                                  TTL=60s
 *  drivers:online          → SET of driverProfileId strings                  Maintained manually
 *  lock:job:{jobId}        → SET NX EX 30 for first-accept-wins
 *
 * ═══════════════════════════════════════════════════════════════
 */

export interface DriverLocation {
    lat: number;
    lng: number;
    heading?: number;
    speed?: number;
    ts: number;        // Unix ms
    status: 'ONLINE' | 'BUSY' | 'OFFLINE';
    jobId?: number;    // if BUSY, the assigned job
}

export interface DriverMeta {
    name: string;
    plate?: string;
    vehicleType?: string;
    userId: number;
    driverProfileId: number;
}

export interface DriverSnapshot {
    driverId: number;
    location: DriverLocation;
    meta: DriverMeta | null;
}

const LOC_TTL = 45; // seconds — driver considered offline if no update in 45s
const DB_PERSIST_INTERVAL_MS = 5000; // throttle DB writes: max once per 5s per driver
const IS_DEBUG = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';

@Injectable()
export class DriverPresenceService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('DriverPresence');
    private heartbeatInterval: NodeJS.Timeout | null = null;

    constructor(
        private redis: RedisService,
        private prisma: PrismaService,
    ) { }

    onModuleInit() {
        // Sweep stale drivers every 15 seconds
        this.heartbeatInterval = setInterval(() => this.sweepOfflineDrivers(), 15_000);
        this.logger.log('Heartbeat sweep started (every 15s)');
    }

    onModuleDestroy() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }

    // ─── Driver Online / Offline ───

    async setOnline(driverProfileId: number, userId: number): Promise<void> {
        const loc: DriverLocation = {
            lat: 0, lng: 0, ts: Date.now(), status: 'ONLINE',
        };
        await this.redis.setJSON(`driver:${driverProfileId}:loc`, loc, LOC_TTL);
        await this.redis.sadd('drivers:online', String(driverProfileId));

        // Update DB
        await this.prisma.driverProfile.update({
            where: { id: driverProfileId },
            data: { isOnline: true },
        });

        if (IS_DEBUG) this.logger.debug(`Driver ${driverProfileId} → ONLINE`);
    }

    async setOffline(driverProfileId: number): Promise<void> {
        await this.redis.del(`driver:${driverProfileId}:loc`);
        await this.redis.srem('drivers:online', String(driverProfileId));
        await this.clearDriverActiveJob(driverProfileId);

        // Update DB
        await this.prisma.driverProfile.update({
            where: { id: driverProfileId },
            data: { isOnline: false },
        }).catch(() => { }); // ignore if profile doesn't exist yet

        if (IS_DEBUG) this.logger.debug(`Driver ${driverProfileId} → OFFLINE`);
    }

    // ─── Active Job Mapping (Redis — zero DB hits for location relay) ───

    /**
     * Map a driver to their active job in Redis.
     * Called when a driver accepts a job.
     */
    async setDriverActiveJob(driverProfileId: number, jobId: number): Promise<void> {
        await this.redis.set(`driver:${driverProfileId}:activeJob`, String(jobId));
        if (IS_DEBUG) this.logger.debug(`Driver ${driverProfileId} → activeJob=${jobId}`);
    }

    /**
     * Get the active jobId for a driver from Redis.
     * Returns null if driver has no active job.
     */
    async getDriverActiveJob(driverProfileId: number): Promise<number | null> {
        const raw = await this.redis.get(`driver:${driverProfileId}:activeJob`);
        if (!raw) return null;
        const parsed = parseInt(raw, 10);
        return isNaN(parsed) ? null : parsed;
    }

    /**
     * Clear the active job mapping for a driver.
     * Called when a job reaches terminal status (DELIVERED, CANCELED).
     */
    async clearDriverActiveJob(driverProfileId: number): Promise<void> {
        await this.redis.del(`driver:${driverProfileId}:activeJob`);
        if (IS_DEBUG) this.logger.debug(`Driver ${driverProfileId} → activeJob cleared`);
    }

    // ─── Location Update ───

    async updateLocation(
        driverProfileId: number,
        lat: number,
        lng: number,
        heading?: number,
        speed?: number,
    ): Promise<DriverLocation> {
        // Read existing to preserve status/jobId
        const existing = await this.redis.getJSON<DriverLocation>(`driver:${driverProfileId}:loc`);
        const loc: DriverLocation = {
            lat,
            lng,
            heading,
            speed,
            ts: Date.now(),
            status: existing?.status || 'ONLINE',
            jobId: existing?.jobId,
        };

        await this.redis.setJSON(`driver:${driverProfileId}:loc`, loc, LOC_TTL);
        // Ensure they're in the online set
        await this.redis.sadd('drivers:online', String(driverProfileId));

        // Throttled DB persist (max once per 5s per driver)
        this.throttledPersistToDB(driverProfileId, lat, lng).catch((err) =>
            this.logger.error(`DB persist failed for driver ${driverProfileId}:`, err),
        );

        return loc;
    }

    /**
     * Persist location to PostgreSQL + PostGIS, throttled to once per DB_PERSIST_INTERVAL_MS.
     * Uses Redis key `driver:{id}:lastPersist` to track last write time.
     */
    private async throttledPersistToDB(driverProfileId: number, lat: number, lng: number): Promise<void> {
        const key = `driver:${driverProfileId}:lastPersist`;
        const lastRaw = await this.redis.get(key);
        const lastTs = lastRaw ? parseInt(lastRaw, 10) : 0;
        const now = Date.now();

        if (now - lastTs < DB_PERSIST_INTERVAL_MS) {
            return; // Too soon, skip this write
        }

        // Mark as persisted BEFORE the write (optimistic — avoids double-write on slow queries)
        await this.redis.set(key, String(now), 60);

        await this.persistLocationToDB(driverProfileId, lat, lng);
    }

    /**
     * Persist location to PostgreSQL + PostGIS.
     * Uses parameterized queries ($executeRaw with Prisma.sql) — NO string interpolation.
     */
    private async persistLocationToDB(driverProfileId: number, lat: number, lng: number): Promise<void> {
        await this.prisma.driverProfile.update({
            where: { id: driverProfileId },
            data: { currentLat: lat, currentLng: lng },
        });
        // Update PostGIS geography column with parameterized query (safe)
        await this.prisma.$executeRaw(
            Prisma.sql`UPDATE "DriverProfile" SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography WHERE id = ${driverProfileId}`
        );
    }

    // ─── Status Management ───

    async setDriverBusy(driverProfileId: number, jobId: number): Promise<void> {
        const loc = await this.redis.getJSON<DriverLocation>(`driver:${driverProfileId}:loc`);
        if (loc) {
            loc.status = 'BUSY';
            loc.jobId = jobId;
            await this.redis.setJSON(`driver:${driverProfileId}:loc`, loc, LOC_TTL);
        }
    }

    async setDriverAvailable(driverProfileId: number): Promise<void> {
        const loc = await this.redis.getJSON<DriverLocation>(`driver:${driverProfileId}:loc`);
        if (loc) {
            loc.status = 'ONLINE';
            loc.jobId = undefined;
            await this.redis.setJSON(`driver:${driverProfileId}:loc`, loc, LOC_TTL);
        }
        await this.clearDriverActiveJob(driverProfileId);
    }

    // ─── Meta ───

    async setMeta(driverProfileId: number, meta: DriverMeta): Promise<void> {
        await this.redis.setJSON(`driver:${driverProfileId}:meta`, meta); // No TTL
    }

    async getMeta(driverProfileId: number): Promise<DriverMeta | null> {
        return this.redis.getJSON<DriverMeta>(`driver:${driverProfileId}:meta`);
    }

    // ─── Queries ───

    async getDriverLocation(driverProfileId: number): Promise<DriverLocation | null> {
        return this.redis.getJSON<DriverLocation>(`driver:${driverProfileId}:loc`);
    }

    async getAllOnlineDrivers(): Promise<DriverSnapshot[]> {
        const memberIds = await this.redis.smembers('drivers:online');
        const snapshots: DriverSnapshot[] = [];

        for (const idStr of memberIds) {
            const id = parseInt(idStr, 10);
            const loc = await this.redis.getJSON<DriverLocation>(`driver:${id}:loc`);
            if (!loc) {
                // Key expired → remove from set
                await this.redis.srem('drivers:online', idStr);
                continue;
            }
            const meta = await this.redis.getJSON<DriverMeta>(`driver:${id}:meta`);
            snapshots.push({ driverId: id, location: loc, meta });
        }

        return snapshots;
    }

    /**
     * Haversine pre-filter: find nearest N available drivers from Redis.
     * Runs entirely in-memory from Redis data — zero Google API calls.
     */
    async findNearestAvailable(
        lat: number,
        lng: number,
        limit: number = 20,
    ): Promise<(DriverSnapshot & { distanceKm: number })[]> {
        const allOnline = await this.getAllOnlineDrivers();

        // Filter to ONLINE (not BUSY), with valid coordinates
        const available = allOnline.filter(
            d => d.location.status === 'ONLINE' && d.location.lat !== 0 && d.location.lng !== 0
        );

        // Compute Haversine distance
        const withDistance = available.map(d => ({
            ...d,
            distanceKm: haversineKm(lat, lng, d.location.lat, d.location.lng),
        }));

        // Sort by distance, take top N
        withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
        return withDistance.slice(0, limit);
    }

    // ─── Heartbeat Sweep ───

    private async sweepOfflineDrivers(): Promise<void> {
        const memberIds = await this.redis.smembers('drivers:online');
        for (const idStr of memberIds) {
            const id = parseInt(idStr, 10);
            const loc = await this.redis.getJSON<DriverLocation>(`driver:${id}:loc`);
            if (!loc) {
                // TTL expired → driver is offline
                await this.redis.srem('drivers:online', idStr);
                await this.clearDriverActiveJob(id);
                // Update DB
                await this.prisma.driverProfile.update({
                    where: { id },
                    data: { isOnline: false },
                }).catch(() => { });
                if (IS_DEBUG) this.logger.debug(`Driver ${id} auto-offlined (heartbeat expired)`);
            }
        }
    }
}

// ─── Haversine Formula ───

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth radius in km
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
