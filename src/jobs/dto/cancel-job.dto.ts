import { IsString, IsOptional, IsEnum } from 'class-validator';

/**
 * Cancellation reason categories.
 * Matches common tow-service cancellation scenarios.
 */
export enum CancelReasonCategory {
    CHANGED_MIND = 'CHANGED_MIND',
    FOUND_ALTERNATIVE = 'FOUND_ALTERNATIVE',
    DRIVER_TOO_FAR = 'DRIVER_TOO_FAR',
    PRICE_TOO_HIGH = 'PRICE_TOO_HIGH',
    WRONG_LOCATION = 'WRONG_LOCATION',
    VEHICLE_FIXED = 'VEHICLE_FIXED',
    DRIVER_REQUESTED = 'DRIVER_REQUESTED',
    CUSTOMER_UNREACHABLE = 'CUSTOMER_UNREACHABLE',
    OTHER = 'OTHER',
}

/**
 * DTO for cancelling a job.
 * Used by: POST /jobs/:id/cancel (customer), POST /admin/jobs/:id/cancel (admin)
 */
export class CancelJobDto {
    @IsOptional()
    @IsEnum(CancelReasonCategory)
    reasonCategory?: CancelReasonCategory;

    @IsOptional()
    @IsString()
    reasonText?: string;
}
