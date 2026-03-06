import { IsString, IsOptional, IsNumber, IsEmail, IsBoolean, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for admin updating a driver profile.
 * Used by: PATCH /admin/drivers/:id
 */
export class UpdateDriverDto {
    @IsOptional()
    @IsString()
    firstName?: string;

    @IsOptional()
    @IsString()
    lastName?: string;

    @IsOptional()
    @IsString()
    licenseNumber?: string;

    @IsOptional()
    @IsString()
    licensePlate?: string;

    @IsOptional()
    @IsString()
    vehicleMake?: string;

    @IsOptional()
    @IsString()
    vehicleModel?: string;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(100)
    @Type(() => Number)
    commissionRate?: number;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @IsBoolean()
    isOnline?: boolean;
}

/**
 * DTO for updating pricing configuration.
 * Used by: PUT /admin/pricing-config
 */
export class UpdatePricingConfigDto {
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    baseFare?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    perKmRate?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    minFare?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    vehicleMultiplierCar?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    vehicleMultiplierSuv?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    vehicleMultiplierMoto?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    morningPeakMultiplier?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    eveningPeakMultiplier?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    nightMultiplier?: number;

    @IsOptional()
    @IsString()
    morningPeakStart?: string;

    @IsOptional()
    @IsString()
    morningPeakEnd?: string;

    @IsOptional()
    @IsString()
    eveningPeakStart?: string;

    @IsOptional()
    @IsString()
    eveningPeakEnd?: string;

    @IsOptional()
    @IsString()
    nightStart?: string;

    @IsOptional()
    @IsString()
    nightEnd?: string;
}
