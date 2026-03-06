import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';

/** Parse DATABASE_URL for safe display (redacts password) */
function getDbInfo(): { host: string; database: string; port: string } {
    try {
        const url = new URL(process.env.DATABASE_URL || '');
        return {
            host: url.hostname,
            database: url.pathname.replace('/', '').split('?')[0],
            port: url.port || '5432',
        };
    } catch {
        return { host: 'unknown', database: 'unknown', port: 'unknown' };
    }
}

@Controller()
export class AppController {
    constructor(
        private readonly appService: AppService,
        private readonly prisma: PrismaService,
    ) { }

    @Get()
    getHello(): string {
        return this.appService.getHello();
    }

    @Get('health')
    async checkHealth() {
        const dbInfo = getDbInfo();

        // Quick DB connectivity check
        let dbConnected = false;
        let jobStatusValues: string[] = [];
        try {
            const result: any[] = await this.prisma.$queryRaw`
                SELECT enumlabel FROM pg_enum 
                WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'JobStatus')
                ORDER BY enumsortorder
            `;
            dbConnected = true;
            jobStatusValues = result.map((r: any) => r.enumlabel);
        } catch (err) {
            dbConnected = false;
        }

        return {
            status: dbConnected ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            env: process.env.NODE_ENV || 'development',
            paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
            db: {
                connected: dbConnected,
                host: dbInfo.host,
                port: dbInfo.port,
                database: dbInfo.database,
            },
            enums: {
                JobStatus: jobStatusValues,
            },
        };
    }
}
