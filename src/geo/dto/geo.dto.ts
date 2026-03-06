import { IsString, IsNumber, IsOptional, IsEnum, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Coordinate pair for route/geo requests.
 */
export class CoordinateDto {
    @IsNumber()
    @Type(() => Number)
    lat!: number;

    @IsNumber()
    @Type(() => Number)
    lng!: number;
}

/**
 * DTO for route calculation.
 * Used by: POST /geo/route
 */
export class GetRouteDto {
    @ValidateNested()
    @Type(() => CoordinateDto)
    pickup!: CoordinateDto;

    @ValidateNested()
    @Type(() => CoordinateDto)
    dropoff!: CoordinateDto;

    @IsOptional()
    @IsString()
    preference?: 'fastest' | 'shortest';
}

/**
 * DTO for pricing quote.
 * Used by: POST /pricing/quote
 */
export class PricingQuoteDto {
    @IsNumber()
    @Type(() => Number)
    distanceKm!: number;

    @IsNumber()
    @Type(() => Number)
    durationMin!: number;

    @IsString()
    vehicleType!: string;
}
