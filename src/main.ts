import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaService } from './prisma.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

/**
 * Dev-only admin bootstrap.
 * Creates an ADMIN user if SEED_ADMIN=true and ADMIN_EMAIL + ADMIN_PASSWORD are set.
 * Idempotent: skips if user with that email already exists.
 * Will NOT run in production unless SEED_ADMIN=true is explicitly set.
 */
async function seedAdmin(prisma: PrismaService) {
    if (process.env.NODE_ENV === 'production' && process.env.SEED_ADMIN !== 'true') return;
    if (process.env.SEED_ADMIN !== 'true') return;

    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;

    if (!email || !password) {
        console.warn('[SEED] SEED_ADMIN=true but ADMIN_EMAIL or ADMIN_PASSWORD missing — skipping');
        return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        if (existing.role !== 'ADMIN') {
            await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN' } });
            console.log(`[SEED] Promoted existing user ${email} to ADMIN`);
        } else {
            console.log(`[SEED] Admin ${email} already exists — skipping`);
        }
        return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
            firstName: 'Admin',
            role: 'ADMIN',
        },
    });
    console.log(`[SEED] Created admin user: ${email}`);
}

/**
 * Auto-seed PricingConfig if missing (e.g. after DB reset).
 * Without this, calculateQuote throws 'Pricing config not found' → 500.
 */
async function seedPricingConfig(prisma: PrismaService) {
    const existing = await prisma.pricingConfig.findUnique({ where: { id: 'default' } });
    if (existing) return;

    await prisma.pricingConfig.create({
        data: {
            id: 'default',
            baseFare: 500,
            perKmRate: 15,
            minFare: 750,
            vehicleMultiplierCar: 1.0,
            vehicleMultiplierSuv: 1.3,
            vehicleMultiplierMoto: 0.8,
            morningPeakStart: '07:00',
            morningPeakEnd: '10:00',
            morningPeakMultiplier: 1.2,
            eveningPeakStart: '17:00',
            eveningPeakEnd: '20:00',
            eveningPeakMultiplier: 1.2,
            nightStart: '22:00',
            nightEnd: '06:00',
            nightMultiplier: 1.3,
        },
    });
    console.log('[SEED] Created default PricingConfig');
}

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    // Global Exception Filter — structured error responses
    app.useGlobalFilters(new GlobalExceptionFilter());

    // ── Global Validation Pipe ──
    // whitelist: strip unknown properties silently (safe rollout)
    // transform: auto-transform payloads to DTO instances
    // Note: forbidNonWhitelisted is intentionally OFF during Phase 3 DTO rollout
    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
    }));

    // ── CORS ──
    // Dev: flexible (localhost + configurable)
    // Prod: strict whitelist from ALLOWED_ORIGINS env var
    const isProduction = process.env.NODE_ENV === 'production';
    const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : [process.env.FRONTEND_URL || 'http://localhost:3000'];

    app.enableCors({
        origin: isProduction
            ? allowedOrigins
            : true, // Allow all origins in development
        credentials: true,
    });

    // Swagger Setup
    const config = new DocumentBuilder()
        .setTitle('BiÇekici API')
        .setDescription('Tow Truck Marketplace API')
        .setVersion('1.0')
        .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);

    // Dev bootstrap
    const prisma = app.get(PrismaService);
    await seedAdmin(prisma);
    await seedPricingConfig(prisma);

    // Log DATABASE_URL on startup (redacted — no password)
    try {
        const dbUrl = new URL(process.env.DATABASE_URL || '');
        console.log(`🗄️  [DB] Connected to: ${dbUrl.hostname}:${dbUrl.port || '5432'}/${dbUrl.pathname.replace('/', '').split('?')[0]}`);
    } catch {
        console.warn('⚠️  [DB] Could not parse DATABASE_URL');
    }

    await app.listen(process.env.PORT || 3001, '0.0.0.0');
    console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
