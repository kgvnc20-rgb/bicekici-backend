import { IsString, IsNumber, IsOptional, IsEnum, IsBoolean, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleType } from '@prisma/client';

/**
 * DTO for calculating a quote or creating a guest quote.
 * Used by: POST /jobs (calculateQuote), POST /jobs/guest (createQuote),
 *          POST /auth/guest-job, POST /payments/guest-process (quoteData)
 */
export class CalculateQuoteDto {
    @IsString()
    pickupAddress!: string;

    @IsString()
    dropoffAddress!: string;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    pickupLat?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    pickupLng?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    dropoffLat?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    dropoffLng?: number;

    @IsOptional()
    @IsString()
    pickupPlaceId?: string;

    @IsOptional()
    @IsString()
    dropoffPlaceId?: string;

    @IsOptional()
    @IsString()
    routePolyline?: string;

    @IsEnum(VehicleType)
    vehicleType!: VehicleType;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    distanceKm?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    durationMin?: number;

    // Vehicle condition fields
    @IsOptional()
    @IsString()
    isDrivable?: string;

    @IsOptional()
    @IsString()
    transmissionType?: string;

    @IsOptional()
    @IsBoolean()
    steeringWorks?: boolean;

    @IsOptional()
    @IsString()
    issueCategory?: string;

    @IsOptional()
    @IsString()
    customerNotes?: string;

    @IsOptional()
    @IsString()
    vehiclePlate?: string;

    @IsOptional()
    @IsString()
    vehicleBrand?: string;

    @IsOptional()
    @IsString()
    vehicleModel?: string;
}
