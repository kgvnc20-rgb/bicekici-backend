import { Module, forwardRef } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { DriversModule } from '../drivers/drivers.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
    imports: [
        DriversModule,
        forwardRef(() => JobsModule),
    ],
    controllers: [AdminController],
})
export class AdminModule { }
