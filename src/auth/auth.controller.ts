import { Controller, Post, Get, Body, UnauthorizedException, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GuestAuthService } from './guest-auth.service';
import { TokenService } from './token.service';
import { JobsService } from '../jobs/jobs.service';
import { Inject, forwardRef } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength, IsOptional, Matches } from 'class-validator';
import { CalculateQuoteDto } from '../jobs/dto/calculate-quote.dto';
import {
    StartGuestVerificationDto,
    VerifyGuestOtpDto,
    RequestOtpDto,
    RefreshTokenDto,
    RevokeSessionDto,
    ConvertAccountDto,
} from './dto/auth.dto';

class RegisterDto {
    @IsString()
    @MinLength(2, { message: 'Ad en az 2 karakter olmalıdır' })
    firstName!: string;

    @IsString()
    @MinLength(2, { message: 'Soyad en az 2 karakter olmalıdır' })
    lastName!: string;

    @IsEmail({}, { message: 'Geçerli bir email adresi giriniz' })
    email!: string;

    @IsString()
    @Matches(/^(\+90|0)?[5][0-9]{9}$/, { message: 'Geçerli bir TR telefon numarası giriniz (örn: 05XX XXX XXXX)' })
    phone!: string;

    @IsString()
    @MinLength(6, { message: 'Şifre en az 6 karakter olmalıdır' })
    password!: string;
}

class LoginDto {
    @IsOptional()
    @IsString()
    identifier?: string;

    @IsOptional()
    @IsString()
    email?: string;

    @IsString()
    password!: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
    constructor(
        private authService: AuthService,
        private guestAuthService: GuestAuthService,
        private tokenService: TokenService,
        @Inject(forwardRef(() => JobsService))
        private jobsService: JobsService
    ) { }

    // ─── Guest Job Quote ───

    @Post('guest-job')
    @ApiOperation({ summary: 'Create initial guest job quote (returns token + quote)' })
    async createGuestJob(@Body() body: CalculateQuoteDto) {
        try {
            const quote = await this.jobsService.calculateQuote(body);
            const guestToken = (this.authService as any).generateGuestToken(0);
            return { quote, guestToken };
        } catch (error: any) {
            throw error;
        }
    }

    // ─── OTP Flow ───

    @Post('otp/request')
    @Throttle({ default: { ttl: 60000, limit: 3 } })
    @ApiOperation({ summary: 'Request OTP (Stub)' })
    async requestOtp(@Body() body: RequestOtpDto) {
        return (this.authService as any).requestOtpStub(body);
    }

    @Post('guest/start')
    @Throttle({ default: { ttl: 60000, limit: 3 } })
    @ApiOperation({ summary: 'Start guest verification (Send OTP)' })
    async startGuestVerification(@Body() body: StartGuestVerificationDto) {
        return this.guestAuthService.startVerification(body);
    }

    @Post('guest/verify')
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({ summary: 'Verify guest OTP → returns access + refresh token pair' })
    async verifyGuestOtp(@Body() body: VerifyGuestOtpDto) {
        return this.guestAuthService.verifyOtp(body);
    }

    // ─── Token Refresh & Sessions ───

    @Post('token/refresh')
    @ApiOperation({ summary: 'Refresh token rotation — exchange refresh token for new pair' })
    async refreshToken(@Body() body: RefreshTokenDto) {
        return this.tokenService.refreshTokens(body.refreshToken, body.deviceId);
    }

    @Get('sessions')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List active sessions for current user' })
    async listSessions(@Request() req: any) {
        return this.tokenService.listSessions(req.user.userId);
    }

    @Post('sessions/revoke')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Revoke session(s) — optionally by deviceId, or all' })
    async revokeSessions(@Request() req: any, @Body() body: RevokeSessionDto) {
        return this.tokenService.revokeSessions(req.user.userId, body.deviceId);
    }

    // ─── Login / Register (existing) ───

    @Post('login')
    @Throttle({ default: { ttl: 60000, limit: 5 } })
    @ApiOperation({ summary: 'Login with email/phone + password/PIN' })
    async login(@Body() loginDto: LoginDto) {
        const identifier = loginDto.identifier || loginDto.email;
        if (!identifier) {
            throw new UnauthorizedException('Email veya telefon numarası gerekli');
        }
        const user = await this.authService.validateUser(identifier, loginDto.password);
        if (!user) {
            throw new UnauthorizedException('Geçersiz kimlik bilgileri');
        }
        return this.authService.login(user);
    }

    @Post('register')
    @Throttle({ default: { ttl: 60000, limit: 3 } })
    @ApiOperation({ summary: 'Register a new customer account' })
    async register(@Body() registerDto: RegisterDto) {
        return this.authService.register(registerDto);
    }

    @Post('convert')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Convert guest account to full account' })
    async convertAccount(@Request() req: any, @Body() body: ConvertAccountDto) {
        return this.guestAuthService.convertAccount(req.user.userId, body);
    }

    // ─── Profile ───

    @Get('me')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get current user profile' })
    async getProfile(@Request() req: any) {
        return this.authService.getProfile(req.user.userId);
    }
}
