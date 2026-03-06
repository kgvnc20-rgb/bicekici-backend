import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private client!: Redis;

    onModuleInit() {
        this.client = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
            db: parseInt(process.env.REDIS_DB || '0', 10),
            retryStrategy: (times) => Math.min(times * 200, 5000),
            lazyConnect: false,
        });

        this.client.on('connect', () => console.log('[Redis] Connected'));
        this.client.on('error', (err) => console.error('[Redis] Error:', err.message));
    }

    onModuleDestroy() {
        this.client?.disconnect();
    }

    getClient(): Redis {
        return this.client;
    }

    // ─── Convenience wrappers ───

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }

    async setJSON(key: string, obj: Record<string, any>, ttlSeconds?: number): Promise<void> {
        await this.set(key, JSON.stringify(obj), ttlSeconds);
    }

    async getJSON<T = any>(key: string): Promise<T | null> {
        const raw = await this.get(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }

    /** SET members */
    async sadd(key: string, ...members: string[]): Promise<void> {
        await this.client.sadd(key, ...members);
    }

    async srem(key: string, ...members: string[]): Promise<void> {
        await this.client.srem(key, ...members);
    }

    async smembers(key: string): Promise<string[]> {
        return this.client.smembers(key);
    }

    async sismember(key: string, member: string): Promise<boolean> {
        return (await this.client.sismember(key, member)) === 1;
    }

    /** Atomic lock: SET NX EX — returns true if lock acquired */
    async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
        const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    }

    async releaseLock(key: string): Promise<void> {
        await this.client.del(key);
    }

    /** Scan for keys matching pattern */
    async scanKeys(pattern: string): Promise<string[]> {
        const keys: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            keys.push(...batch);
        } while (cursor !== '0');
        return keys;
    }
}
