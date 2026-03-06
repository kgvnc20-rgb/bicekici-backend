import { IsString, IsNumber, IsOptional, IsEmail, ValidateNested, IsEnum, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { CalculateQuoteDto } from '../../jobs/dto/calculate-quote.dto';
import { JobStatus } from '@prisma/client';

/**
 * Guest info portion of guest payment request.
 */
export class GuestInfoDto {
    @IsString()
    firstName!: string;

    @IsString()
    lastName!: string;

    @IsString()
    phone!: string;

    @IsOptional()
    @IsEmail()
    email?: string;

    // Vehicle condition fields (passed alongside quote data)
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

/**
 * Full guest payment request: quoteData + guestInfo.
 * Used by: POST /payments/guest-process
 */
export class ProcessGuestPaymentDto {
    @ValidateNested()
    @Type(() => CalculateQuoteDto)
    quoteData!: CalculateQuoteDto;

    @ValidateNested()
    @Type(() => GuestInfoDto)
    guestInfo!: GuestInfoDto;
}

/**
 * Init payment request.
 * Used by: POST /payments/init
 */
export class InitPaymentDto {
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    jobId?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    estimatedPrice?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    amount?: number;

    // ── Buyer info ──
    @IsOptional()
    @IsString()
    firstName?: string;

    @IsOptional()
    @IsString()
    lastName?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsEmail()
    email?: string;

    // ── Quote fields (needed by createQuoteJob) ──
    @IsOptional()
    @IsString()
    pickupAddress?: string;

    @IsOptional()
    @IsString()
    dropoffAddress?: string;

    @IsOptional()
    @Type(() => Number)
    pickupLat?: number;

    @IsOptional()
    @Type(() => Number)
    pickupLng?: number;

    @IsOptional()
    @Type(() => Number)
    dropoffLat?: number;

    @IsOptional()
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

    @IsOptional()
    @IsString()
    vehicleType?: string;

    @IsOptional()
    @Type(() => Number)
    distanceKm?: number;

    @IsOptional()
    @Type(() => Number)
    durationMin?: number;

    // ── Vehicle condition (optional) ──
    @IsOptional()
    @IsString()
    isDrivable?: string;

    @IsOptional()
    @IsString()
    transmissionType?: string;

    @IsOptional()
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

/**
 * Mock payment confirm request (wraps quoteData).
 * Used by: POST /payments/mock/confirm
 */
export class MockConfirmPaymentDto {
    @ValidateNested()
    @Type(() => CalculateQuoteDto)
    quoteData!: CalculateQuoteDto;
}

/**
 * Update job status request (for driver status updates).
 * Used by: POST /drivers/jobs/:id/status
 */
export class UpdateJobStatusDto {
    @IsEnum(JobStatus)
    status!: JobStatus;
}
