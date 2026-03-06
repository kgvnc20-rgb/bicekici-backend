import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DriverPresenceService } from '../drivers/driver-presence.service';
import { DriversService } from '../drivers/drivers.service';
import { JobsService } from '../jobs/jobs.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JobStatus } from '@prisma/client';
import { UpdateDriverDto } from './dto/admin.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
    constructor(
        private readonly presenceService: DriverPresenceService,
        private readonly driversService: DriversService,
        private readonly jobsService: JobsService,
    ) { }

    @Get('dashboard-stats')
    @ApiOperation({ summary: 'Get KPI dashboard stats' })
    async getDashboardStats(@Query('period') period?: string) {
        const p = (['today', 'week', 'month'].includes(period || '') ? period : 'today') as 'today' | 'week' | 'month';

        const [jobStats, onlineDrivers] = await Promise.all([
            this.jobsService.getDashboardStats(p),
            this.presenceService.getAllOnlineDrivers(),
        ]);

        return {
            ...jobStats,
            activeDrivers: onlineDrivers.length,
        };
    }

    @Patch('drivers/:id')
    @ApiOperation({ summary: 'Update driver profile (commission, name, plate, status)' })
    async updateDriver(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateDriverDto) {
        return this.driversService.updateDriver(id, body);
    }

    @Get('dispatch-data')
    @ApiOperation({ summary: 'Get all data for dispatch map (initial load)' })
    async getDispatchData() {
        const [onlineDrivers, activeJobs] = await Promise.all([
            this.presenceService.getAllOnlineDrivers(),
            this.jobsService.getActiveJobs(),
        ]);

        return {
            drivers: onlineDrivers,
            jobs: activeJobs,
            ts: Date.now(),
        };
    }

    @Get('jobs')
    @ApiOperation({ summary: 'List all jobs (with optional status filter)' })
    async getJobs(@Query('status') status?: string) {
        const filters = status ? { status: status as JobStatus } : undefined;
        return this.jobsService.findAllAdmin(filters);
    }

    @Get('drivers')
    @ApiOperation({ summary: 'List all drivers with profiles and online status' })
    async getDrivers() {
        const [allDrivers, onlineSnapshots] = await Promise.all([
            this.driversService.getAllDrivers(),
            this.presenceService.getAllOnlineDrivers(),
        ]);

        const onlineMap = new Map(onlineSnapshots.map(s => [s.driverId, s]));

        return allDrivers.map(driver => ({
            ...driver,
            liveStatus: onlineMap.has(driver.id) ? onlineMap.get(driver.id)!.location.status : 'OFFLINE',
            liveLocation: onlineMap.get(driver.id)?.location || null,
        }));
    }
}
