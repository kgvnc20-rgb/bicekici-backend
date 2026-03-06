
import { Injectable, BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { TokenService } from './token.service';
import { SMS_PROVIDER, SmsProvider } from '../notifications/providers/sms-provider.interface';
import * as crypto from 'crypto';

@Injectable()
export class GuestAuthService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
        private tokenService: TokenService,
        @Inject(SMS_PROVIDER) private smsProvider: SmsProvider,
    ) { }

    /**
     * Start guest verification flow.
     * 1. Normalize inputs
     * 2. Create or update guest User
     * 3. Generate OTP
     * 4. Send SMS (Netgsm stub)
     */
    async startVerification(data: { phone: string; email?: string; jobId?: number }) {
        const normalizedPhone = this.normalizePhone(data.phone);
        if (!normalizedPhone) throw new BadRequestException('Geçersiz telefon numarası');

        // Find or create user
        let user = await this.prisma.user.findFirst({
            where: { phone: normalizedPhone }
        });

        if (!user) {
            user = await this.prisma.user.create({
                data: {
                    phone: normalizedPhone,
                    email: data.email || undefined,
                    role: 'CUSTOMER',
                    isGuest: true
                }
            });
        } else if (data.email && !user.email) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { email: data.email }
            });
        }

        // Generate 6-digit OTP
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');

        // Create OTP record (expires in 3 mins)
        await this.prisma.otpVerification.create({
            data: {
                userId: user.id,
                channel: 'PHONE',
                destination: normalizedPhone,
                codeHash: codeHash,
                expiresAt: new Date(Date.now() + 3 * 60 * 1000),
            }
        });

        // Send OTP via SMS provider
        await this.smsProvider.send(normalizedPhone, `BiÇekici doğrulama kodunuz: ${code}`);

        return {
            message: 'Doğrulama kodu gönderildi',
            userId: user.id,
            // DEV ONLY: return code for testing
            devCode: process.env.NODE_ENV !== 'production' ? code : undefined,
        };
    }

    /**
     * Verify OTP code.
     * Now issues access + refresh token pair via TokenService.
     * Accepts deviceId + deviceName for device-bound sessions.
     */
    async verifyOtp(data: {
        phone: string;
        code: string;
        jobId?: number;
        deviceId?: string;
        deviceName?: string;
    }) {
        const normalizedPhone = this.normalizePhone(data.phone);
        const codeHash = crypto.createHash('sha256').update(data.code).digest('hex');

        // Find valid OTP
        const otp = await this.prisma.otpVerification.findFirst({
            where: {
                destination: normalizedPhone,
                channel: 'PHONE',
                codeHash: codeHash,
                verifiedAt: null,
                expiresAt: { gt: new Date() }
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!otp) {
            throw new BadRequestException('Geçersiz veya süresi dolmuş kod');
        }

        // Mark OTP as verified
        await this.prisma.otpVerification.update({
            where: { id: otp.id },
            data: { verifiedAt: new Date() }
        });

        // Mark User as phone-verified
        const user = await this.prisma.user.update({
            where: { id: otp.userId! },
            data: { phoneVerifiedAt: new Date() }
        });

        // Attach job to customer if jobId provided
        let attachedJobId = data.jobId;
        if (attachedJobId) {
            await this.prisma.serviceRequest.update({
                where: { id: attachedJobId },
                data: { customerId: user.id },
            }).catch((e: any) => {
                console.warn('[GuestAuth] Failed to attach job to customer:', e.message);
            });
        }

        // Issue device-bound token pair via TokenService
        const deviceId = data.deviceId || `unknown-${Date.now()}`;
        const tokens = await this.tokenService.issueTokenPair(
            user,
            deviceId,
            data.deviceName,
        );

        return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresIn: tokens.expiresIn,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone,
                role: user.role,
                isGuest: user.isGuest
            },
            jobId: attachedJobId,
        };
    }

    /**
     * Convert Guest to Full Account
     */
    async convertAccount(userId: number, data: { password: string; firstName: string; lastName: string }) {
        const hashedPassword = await (await import('bcrypt')).hash(data.password, 10);

        const user = await this.prisma.user.update({
            where: { id: userId },
            data: {
                password: hashedPassword,
                firstName: data.firstName,
                lastName: data.lastName,
                isGuest: false
            }
        });

        const { password, ...result } = user;
        return result;
    }

    // ─── Utility ───

    private normalizePhone(phone: string): string {
        const digits = phone.replace(/[\s\-\(\)]/g, '');
        if (digits.startsWith('+90')) return digits;
        if (digits.startsWith('90') && digits.length === 12) return '+' + digits;
        if (digits.startsWith('0') && digits.length === 11) return '+90' + digits.slice(1);
        if (digits.startsWith('5') && digits.length === 10) return '+90' + digits;
        return '';
    }
}
