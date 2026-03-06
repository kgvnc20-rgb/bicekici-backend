import { Controller, Post, Get, Patch, Body, Param, Query, UseGuards, Request, ParseIntPipe, HttpCode, ConflictException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DriversService } from '../drivers/drivers.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JobStatus } from '@prisma/client';
import { CalculateQuoteDto } from './dto/calculate-quote.dto';
import { CancelJobDto } from './dto/cancel-job.dto';

@ApiTags('Jobs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('jobs')
export class JobsController {
    constructor(
        private readonly jobsService: JobsService,
        private readonly driversService: DriversService,
    ) { }

    @Post()
    @Roles('CUSTOMER', 'ADMIN')
    @ApiOperation({ summary: 'Calculate a price quote for a tow job' })
    async calculateQuote(@Request() req: any, @Body() body: CalculateQuoteDto) {
        return this.jobsService.calculateQuote(body);
    }

    @Get()
    @Roles('CUSTOMER')
    @ApiOperation({ summary: 'Get my jobs' })
    async findAll(@Request() req: any) {
        return this.jobsService.findAll(req.user.userId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get job details' })
    async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
        const isAdmin = req.user.role === 'ADMIN';
        return this.jobsService.findOne(req.user.userId, id, isAdmin);
    }

    @Patch(':id/status')
    @ApiOperation({ summary: 'Update job status' })
    async updateStatus(
        @Request() req: any,
        @Param('id', ParseIntPipe) id: number,
        @Body('status') status: JobStatus,
    ) {
        const isAdmin = req.user.role === 'ADMIN';
        return this.jobsService.updateStatus(req.user.userId, id, status, isAdmin);
    }

    // ─── Cancel ───

    @Post(':id/cancel')
    @Roles('CUSTOMER', 'ADMIN')
    @HttpCode(200)
    @ApiOperation({ summary: 'Cancel a job (customer or admin)' })
    async cancelJob(
        @Request() req: any,
        @Param('id', ParseIntPipe) id: number,
        @Body() body: CancelJobDto,
    ) {
        const cancelledBy = req.user.role === 'ADMIN' ? 'ADMIN' : 'CUSTOMER';
        const reason = body.reasonText || body.reasonCategory;
        return this.jobsService.cancelJob(id, cancelledBy, reason, req.user.userId);
    }

    @Post(':id/driver-cancel')
    @Roles('DRIVER')
    @HttpCode(200)
    @ApiOperation({ summary: 'Cancel a job (driver)' })
    async driverCancelJob(
        @Request() req: any,
        @Param('id', ParseIntPipe) id: number,
        @Body() body: CancelJobDto,
    ) {
        const reason = body.reasonText || body.reasonCategory;
        return this.jobsService.cancelJob(id, 'DRIVER', reason, req.user.userId);
    }

    @Post(':id/dispatch')
    @Roles('ADMIN')
    @ApiOperation({ summary: 'Admin Manual Re-dispatch (MATCHING → notify drivers again)' })
    async manualDispatch(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
        const result = await this.jobsService.dispatchJob(id);

        if (!result || result.dispatched === false) {
            if (result?.status && ['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'LOADED', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED', 'CANCELED'].includes(result.status)) {
                throw new ConflictException('Job already assigned or in progress');
            }
            return { success: false, message: 'No drivers found or job not in MATCHING status', status: result?.status };
        }

        return { success: true, count: result.count, status: result.status };
    }

    // ─── Driver: Accept / Decline ───

    @Post(':id/accept')
    @Roles('DRIVER')
    @HttpCode(200)
    @ApiOperation({ summary: 'Accept a job offer (driver)' })
    async acceptJob(
        @Request() req: any,
        @Param('id', ParseIntPipe) jobId: number,
        @Body() body: { offerId?: number },
    ) {
        const profile = await this.driversService.ensureProfile(req.user.userId);
        return this.jobsService.acceptJob(profile.id, jobId, body?.offerId);
    }

    @Post(':id/decline')
    @Roles('DRIVER')
    @HttpCode(200)
    @ApiOperation({ summary: 'Decline a job offer (driver)' })
    async declineJob(@Request() req: any, @Param('id', ParseIntPipe) jobId: number) {
        const profile = await this.driversService.ensureProfile(req.user.userId);
        return this.jobsService.declineJob(profile.id, jobId);
    }
}
