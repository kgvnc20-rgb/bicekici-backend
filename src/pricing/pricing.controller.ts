import { Controller, Get, Put, Post, UseGuards, Query, Body, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PricingService, PriceEstimate } from './pricing.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PricingQuoteDto } from '../geo/dto/geo.dto';
import { UpdatePricingConfigDto } from '../admin/dto/admin.dto';

@ApiTags('Pricing')
@Controller('pricing')
export class PricingController {
    constructor(private readonly pricingService: PricingService) { }

    @Post('quote')
    @ApiOperation({ summary: 'Calculate detailed quote based on route' })
    async getQuote(@Body() body: PricingQuoteDto) {
        return this.pricingService.calculateQuote(body.distanceKm, body.durationMin, body.vehicleType);
    }
}

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminPricingController {
    constructor(private readonly pricingService: PricingService) { }

    @Get('pricing-config')
    async getConfig() {
        return this.pricingService.getPricingConfig();
    }

    @Put('pricing-config')
    async updateConfig(@Body() body: UpdatePricingConfigDto) {
        return this.pricingService.updatePricingConfig(body);
    }
}
