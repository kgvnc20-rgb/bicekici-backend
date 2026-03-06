import { IsString, IsOptional, IsNumber, IsEmail, IsEnum, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for guest start verification (send OTP).
 * Used by: POST /auth/guest/start
 */
export class StartGuestVerificationDto {
    @IsString()
    @Matches(/^(\+90|0)?[5][0-9]{9}$/, { message: 'Geçerli bir TR telefon numarası giriniz' })
    phone!: string;

    @IsOptional()
    @IsEmail()
    email?: string;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    jobId?: number;
}

/**
 * DTO for guest OTP verification.
 * Used by: POST /auth/guest/verify
 */
export class VerifyGuestOtpDto {
    @IsString()
    phone!: string;

    @IsString()
    code!: string;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    jobId?: number;

    @IsOptional()
    @IsString()
    deviceId?: string;

    @IsOptional()
    @IsString()
    deviceName?: string;
}

/**
 * DTO for OTP request (stub).
 * Used by: POST /auth/otp/request
 */
export class RequestOtpDto {
    @IsString()
    phone!: string;

    @IsOptional()
    @IsEmail()
    email?: string;
}

/**
 * DTO for token refresh.
 * Used by: POST /auth/token/refresh
 */
export class RefreshTokenDto {
    @IsString()
    refreshToken!: string;

    @IsString()
    deviceId!: string;
}

/**
 * DTO for session revocation.
 * Used by: POST /auth/sessions/revoke
 */
export class RevokeSessionDto {
    @IsOptional()
    @IsString()
    deviceId?: string;
}

/**
 * DTO for account conversion (guest → full).
 * Used by: POST /auth/convert
 */
export class ConvertAccountDto {
    @IsString()
    password!: string;

    @IsString()
    firstName!: string;

    @IsString()
    lastName!: string;
}
