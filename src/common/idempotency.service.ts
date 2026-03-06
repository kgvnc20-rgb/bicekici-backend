import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import * as crypto from 'crypto';

/**
 * Centralized Idempotency Service
 *
 * Provides atomic, Redis-backed idempotency checks to prevent
 * duplicate operations (payments, job creation, state transitions).
 *
 * Uses Redis SETNX (SET if Not eXists) for distributed safety.
 * Works correctly even across multiple backend instances.
 *
 * Usage:
 *   const key = idempotencyService.generateKey('payment', phone, pickupAddress);
 *   const isNew = await idempotencyService.checkAndSet(key, 3600);
 *   if (!isNew) return existingResult; // duplicate
 *   // ... proceed with operation
 */
@Injectable()
export class IdempotencyService {
    private readonly logger = new Logger('Idempotency');

    constructor(private readonly redis: RedisService) { }

    /**
     * Generate a deterministic idempotency key from identifying fields.
     * Returns a SHA-256 hash prefix for storage efficiency.
     */
    generateKey(...parts: (string | number | undefined | null)[]): string {
        const raw = parts.filter(p => p !== undefined && p !== null).join('|');
        return `idempotent:${crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32)}`;
    }

    /**
     * Atomically check if an operation has been performed, and mark it if not.
     *
     * @param key - Idempotency key from generateKey()
     * @param ttlSeconds - How long to remember this operation (prevents replay)
     * @returns true if this is a NEW operation (proceed); false if DUPLICATE (skip)
     */
    async checkAndSet(key: string, ttlSeconds: number = 3600): Promise<boolean> {
        const acquired = await this.redis.acquireLock(key, ttlSeconds);
        if (!acquired) {
            this.logger.log(`⚡ Idempotent hit: ${key}`);
        }
        return acquired;
    }

    /**
     * Store a result associated with an idempotency key.
     * Used to return the original result on duplicate requests.
     */
    async storeResult(key: string, result: any, ttlSeconds: number = 3600): Promise<void> {
        await this.redis.setJSON(`${key}:result`, result, ttlSeconds);
    }

    /**
     * Retrieve a previously stored result for an idempotency key.
     */
    async getStoredResult<T = any>(key: string): Promise<T | null> {
        return this.redis.getJSON<T>(`${key}:result`);
    }

    /**
     * Release an idempotency key (e.g., on operation failure to allow retry).
     */
    async release(key: string): Promise<void> {
        await this.redis.del(key);
        await this.redis.del(`${key}:result`);
    }
}
