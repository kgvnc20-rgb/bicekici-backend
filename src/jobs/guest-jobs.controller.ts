import { Controller, Post, Get, Body, Param, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { JobsService } from './jobs.service';
import { AuthService } from '../auth/auth.service';
import { CalculateQuoteDto } from './dto/calculate-quote.dto';

@ApiTags('Guest Jobs')
@Controller('jobs/guest')
export class GuestJobsController {
    constructor(
        private jobsService: JobsService,
        private authService: AuthService,
    ) { }

    /**
     * POST /jobs/guest — Calculate quote and return guestToken.
     * No auth required. No Job is created yet (payment-first).
     */
    @Post()
    @ApiOperation({ summary: 'Get quote for guest (no auth, returns guestToken + quote)' })
    async createQuote(@Body() body: CalculateQuoteDto) {
        const quote = await this.jobsService.calculateQuote(body);
        const guestToken = this.authService.generateGuestToken(0);

        return {
            guestToken,
            price: quote.estimatedPrice,
            quote,
        };
    }

    /**
     * GET /jobs/guest/nearby-availability?lat=X&lng=Y
     * Returns count of nearby drivers + average distance for dynamic ETA.
     */
    @Get('nearby-availability')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get nearby driver availability for ETA display' })
    async getNearbyAvailability(
        @Request() req: any,
        @Param() params: any,
    ) {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        if (isNaN(lat) || isNaN(lng)) {
            throw new BadRequestException('lat and lng query params required');
        }
        return this.jobsService.getNearbyAvailability(lat, lng);
    }

    /**
     * GET /jobs/guest/:jobId — Fetch job data with guestToken.
     * The JWT payload must contain jobId matching the param.
     */
    @Get(':jobId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get guest job by ID (requires guestToken or customerToken)' })
    async getGuestJob(@Param('jobId') jobId: string, @Request() req: any) {
        const id = parseInt(jobId, 10);
        const user = req.user;

        if (user.role === 'GUEST') {
            if (user.jobId !== id) {
                throw new BadRequestException({
                    errorCode: 'FORBIDDEN',
                    message: 'Bu talebe erişim yetkiniz yok',
                });
            }
        }

        const job = await this.jobsService.getJobById(id);
        if (!job) {
            throw new BadRequestException({
                errorCode: 'JOB_NOT_FOUND',
                message: 'Talep bulunamadı',
            });
        }

        return job;
    }
}
