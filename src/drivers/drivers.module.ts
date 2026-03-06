import { Module, forwardRef } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { DriverPresenceService } from './driver-presence.service';
import { DriverApplicationController } from './driver-application.controller';
import { DriverApplicationService } from './driver-application.service';
import { DriverInviteController } from './driver-invite.controller';
import { DriverInviteService } from './driver-invite.service';
import { EtaService } from './eta.service';
import { DriverEarningsService } from './driver-earnings.service';
import { PrismaService } from '../prisma.service';
import { JobsModule } from '../jobs/jobs.module';

@Module({
    imports: [
        MulterModule.register({ dest: './uploads' }),
        forwardRef(() => JobsModule),
    ],
    controllers: [DriversController, DriverApplicationController, DriverInviteController],
    providers: [DriversService, DriverPresenceService, DriverApplicationService, DriverInviteService, EtaService, DriverEarningsService, PrismaService],
    exports: [DriversService, DriverPresenceService, DriverApplicationService, EtaService, DriverEarningsService],
})
export class DriversModule { }

