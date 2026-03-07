import { Module } from '@nestjs/common';
import { PricingController, AdminPricingController } from './pricing.controller';
import { PricingService } from './pricing.service';
import { PrismaService } from '../prisma.service';

@Module({
    controllers: [PricingController, AdminPricingController],
    providers: [PricingService, PrismaService],
    exports: [PricingService],
})
export class PricingModule { }
