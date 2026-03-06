
import { Controller, Get, Post, Param, Body, UseGuards, Request, Query, ParseIntPipe, ForbiddenException, BadRequestException } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUserId } from '../auth/current-user.decorator';
import { UpdateJobStatusDto } from '../payments/dto/payment.dto';
import { EtaService } from './eta.service';
import { DriverEarningsService } from './driver-earnings.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('Drivers')
@ApiBearerAuth()
@Controller('drivers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class DriversController {
    constructor(
        private jobsService: JobsService,
        private prisma: PrismaService,
        private etaService: EtaService,
        private earningsService: DriverEarningsService,
    ) { }

    @Get('me')
    @Roles('DRIVER')
    async getMe(@CurrentUserId() userId: number) {
        const driver = await this.prisma.driverProfile.findUnique({
            where: { userId },
            select: { id: true, isOnline: true, isActive: true }
        });
        if (!driver) throw new ForbiddenException('Driver profile not found');
        return driver;
    }

    @Get('nearby-jobs')
    @Roles('DRIVER')
    async getNearbyJobs(
        @CurrentUserId() userId: number,
        @Query('lat') lat: string,
        @Query('lng') lng: string,
    ) {
        if (!lat || !lng) {
            throw new BadRequestException('lat and lng query parameters are required');
        }

        const driver = await this.prisma.driverProfile.findUnique({
            where: { userId },
        });

        if (!driver) throw new ForbiddenException('Driver profile not found');

        return this.jobsService.getNearbyJobs(driver.id, parseFloat(lat), parseFloat(lng));
    }

    @Post('jobs/:id/accept')
    @Roles('DRIVER')
    async acceptJob(
        @CurrentUserId() userId: number,
        @Param('id', ParseIntPipe) jobId: number
    ) {
        const driver = await this.prisma.driverProfile.findUnique({
            where: { userId },
        });

        if (!driver) throw new ForbiddenException('Driver profile not found');

        if (!driver.isOnline || !driver.isActive) {
            throw new ForbiddenException('You must be Online and Active to accept jobs');
        }

        return this.jobsService.acceptJob(driver.id, jobId);
    }

    @Get('active-job')
    @Roles('DRIVER')
    @ApiOperation({ summary: 'Get active job with ETA' })
    async getActiveJob(@CurrentUserId() userId: number) {
        const driver = await this.prisma.driverProfile.findUnique({ where: { userId } });
        if (!driver) return null;

        const job = await this.prisma.serviceRequest.findFirst({
            where: {
                driverId: driver.id,
                status: { in: ['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'LOADED', 'EN_ROUTE_TO_DROPOFF'] }
            },
            include: { customer: { select: { phone: true, firstName: true, lastName: true } } }
        });

        if (!job) return null;

        // Enrich with ETA
        const eta = await this.etaService.calculateEta(job.id);

        return {
            ...job,
            eta: eta || null,
        };
    }

    // ─── ETA ───

    @Get('jobs/:id/eta')
    @Roles('DRIVER', 'CUSTOMER', 'ADMIN')
    @ApiOperation({ summary: 'Get ETA for a specific job' })
    async getJobEta(@Param('id', ParseIntPipe) jobId: number) {
        const eta = await this.etaService.calculateEta(jobId);
        if (!eta) return { etaMinutes: null, message: 'ETA not available' };
        return eta;
    }

    // ─── Earnings ───

    @Get('earnings')
    @Roles('DRIVER')
    @ApiOperation({ summary: 'Get driver earnings summary' })
    async getEarnings(
        @CurrentUserId() userId: number,
        @Query('period') period?: string,
    ) {
        const driver = await this.prisma.driverProfile.findUnique({ where: { userId } });
        if (!driver) throw new ForbiddenException('Driver profile not found');

        const validPeriod = (['today', 'week', 'month', 'all'].includes(period || '') ? period : 'month') as 'today' | 'week' | 'month' | 'all';
        return this.earningsService.getEarningsSummary(driver.id, validPeriod);
    }

    @Post('jobs/:id/status')
    @Roles('DRIVER')
    async updateStatus(
        @CurrentUserId() userId: number,
        @Param('id', ParseIntPipe) jobId: number,
        @Body() body: UpdateJobStatusDto,
    ) {
        const driver = await this.prisma.driverProfile.findUnique({ where: { userId } });
        if (!driver) throw new ForbiddenException('Driver profile not found');

        return this.jobsService.updateJobStatusByDriver(driver.id, jobId, body.status);
    }
}

