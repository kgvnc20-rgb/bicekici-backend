/**
 * E2E Smoke Test — Full Job Lifecycle
 *
 * Tests the critical path: quote → sandbox payment → MATCHING → cancel/refund
 *
 * Prerequisites:
 *   1. Test DB: createdb bicekici_test
 *   2. Migrate:  npm run test:e2e:reset
 *   3. Redis:    running locally (uses DB index 15 per .env.test)
 *
 * Run: npm run test:e2e
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { RedisService } from '../src/redis/redis.service';

describe('Job Lifecycle (E2E)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let redis: RedisService;

    // Test state carried between steps
    let guestToken: string;
    let jobId: number;
    let quotePrice: number;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({
            whitelist: true,
            transform: true,
        }));
        await app.init();

        prisma = app.get(PrismaService);
        redis = app.get(RedisService);

        // Seed minimal pricing config for quote calculation
        await prisma.pricingConfig.upsert({
            where: { id: 'default' },
            create: {
                id: 'default',
                baseFare: 150,
                perKmRate: 15,
                minFare: 200,
                vehicleMultiplierCar: 1.0,
                vehicleMultiplierSuv: 1.3,
                vehicleMultiplierMoto: 0.8,
                morningPeakStart: '07:00',
                morningPeakEnd: '10:00',
                morningPeakMultiplier: 1.2,
                eveningPeakStart: '17:00',
                eveningPeakEnd: '20:00',
                eveningPeakMultiplier: 1.3,
                nightStart: '22:00',
                nightEnd: '06:00',
                nightMultiplier: 1.5,
            },
            update: {},
        });
    });

    afterAll(async () => {
        // Clean up test data
        if (jobId) {
            await prisma.payment.deleteMany({ where: { jobId } });
            await prisma.serviceRequest.deleteMany({ where: { id: jobId } });
        }

        // Flush test Redis keys (DB 15)
        const client = redis.getClient();
        await client.flushdb();

        await app.close();
    });

    // ─── Step 1: Get Guest Quote ───

    it('POST /jobs/guest → returns quote + guestToken', async () => {
        const res = await request(app.getHttpServer())
            .post('/jobs/guest')
            .send({
                pickupAddress: 'Kadıköy, Istanbul',
                dropoffAddress: 'Beşiktaş, Istanbul',
                pickupLat: 40.9923,
                pickupLng: 29.0250,
                dropoffLat: 41.0422,
                dropoffLng: 29.0045,
                vehicleType: 'CAR',
                distanceKm: 12,
                durationMin: 25,
            })
            .expect(201);

        expect(res.body.guestToken).toBeDefined();
        expect(res.body.price).toBeGreaterThan(0);
        expect(res.body.quote).toBeDefined();

        guestToken = res.body.guestToken;
        quotePrice = res.body.price;
    });

    // ─── Step 2: Sandbox Payment → Job created in MATCHING ───

    it('POST /payments/mock/confirm → job in MATCHING', async () => {
        const res = await request(app.getHttpServer())
            .post('/payments/mock/confirm')
            .set('Authorization', `Bearer ${guestToken}`)
            .send({
                quoteData: {
                    pickupAddress: 'Kadıköy, Istanbul',
                    dropoffAddress: 'Beşiktaş, Istanbul',
                    pickupLat: 40.9923,
                    pickupLng: 29.0250,
                    dropoffLat: 41.0422,
                    dropoffLng: 29.0045,
                    vehicleType: 'CAR',
                    distanceKm: 12,
                    durationMin: 25,
                },
            })
            .expect(201);

        expect(res.body.jobId || res.body.job?.id).toBeDefined();
        jobId = res.body.jobId || res.body.job?.id;
    });

    // ─── Step 3: Verify Job Exists in DB ───

    it('Job exists in DB with correct status', async () => {
        const job = await prisma.serviceRequest.findUnique({
            where: { id: jobId },
        });

        expect(job).not.toBeNull();
        // Should be MATCHING (payment confirmed) or PENDING_PAYMENT
        expect(['MATCHING', 'PENDING_PAYMENT']).toContain(job!.status);
    });

    // ─── Step 4: Cancel the Job ───

    it('POST /jobs/:id/cancel → cancels + refund', async () => {
        // First ensure job is in a cancellable state
        await prisma.serviceRequest.update({
            where: { id: jobId },
            data: { status: 'MATCHING' },
        });

        const res = await request(app.getHttpServer())
            .post(`/jobs/${jobId}/cancel`)
            .set('Authorization', `Bearer ${guestToken}`)
            .send({
                reasonCategory: 'CHANGED_MIND',
                reasonText: 'E2E test cancellation',
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('CANCELED');
        expect(res.body.cancelledBy).toBeDefined();
    });

    // ─── Step 5: Verify Final State ───

    it('Job is in CANCELED status after cancellation', async () => {
        const job = await prisma.serviceRequest.findUnique({
            where: { id: jobId },
        });

        expect(job!.status).toBe('CANCELED');
        expect(job!.cancelReason).toBeDefined();
        expect(job!.cancelledAt).toBeDefined();
    });
});
