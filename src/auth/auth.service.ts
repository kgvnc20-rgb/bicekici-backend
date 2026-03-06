import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
    ) { }

    /**
     * Normalize a Turkish phone number to +905XXXXXXXXX format.
     * Accepts: 05XX..., 5XX..., +905XX..., 905XX...
     */
    private normalizePhone(phone?: string): string {
        if (!phone) return '';
        const digits = phone.replace(/[\s\-\(\)]/g, '');
        if (digits.startsWith('+90')) return digits;
        if (digits.startsWith('90') && digits.length === 12) return '+' + digits;
        if (digits.startsWith('0') && digits.length === 11) return '+90' + digits.slice(1);
        if (digits.startsWith('5') && digits.length === 10) return '+90' + digits;
        return digits; // fallback — return as-is
    }

    /**
     * Validate user by identifier (email or phone) + password/PIN.
     * Looks up user by email OR normalized phone.
     */
    async validateUser(identifier: string, pass: string): Promise<any> {
        if (!identifier || !pass) {
            console.log('[AUTH] validateUser called with empty identifier or password');
            return null;
        }

        const normalizedPhone = this.normalizePhone(identifier);
        console.log(`[AUTH] validateUser identifier=${identifier} normalizedPhone=${normalizedPhone}`);

        // Search by email OR phone (both raw and normalized to handle non-normalized DB records)
        const phoneConditions: any[] = [];
        if (normalizedPhone) phoneConditions.push({ phone: normalizedPhone });
        // Also search raw identifier as phone (in case DB stores raw format)
        if (identifier !== normalizedPhone) phoneConditions.push({ phone: identifier });

        const user = await this.prisma.user.findFirst({
            where: {
                OR: [
                    { email: identifier },
                    ...phoneConditions,
                ],
            },
        });

        console.log(`[AUTH] user found: ${user ? `id=${user.id} role=${user.role} phone=${user.phone} hasPassword=${!!user.password}` : 'null'}`);

        // Guest users have no password, so they cannot login via this method
        if (user && user.password && (await bcrypt.compare(pass, user.password))) {
            const { password, ...result } = user;
            return result; // return user object without password
        }
        return null;
    }

    async login(user: any) {
        const payload = { email: user.email, sub: user.id, role: user.role, sessionVersion: user.sessionVersion };
        return {
            access_token: this.jwtService.sign(payload),
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
            },
        };
    }

    async register(data: { firstName: string; lastName: string; email: string; phone: string; password: string }) {
        // Check email uniqueness
        const existingEmail = await this.prisma.user.findUnique({ where: { email: data.email } });
        if (existingEmail) {
            throw new ConflictException('Bu email adresi zaten kayıtlı');
        }

        // Check phone uniqueness — normalize first
        const normalizedPhone = this.normalizePhone(data.phone);
        const existingPhone = await this.prisma.user.findFirst({ where: { phone: normalizedPhone } });
        if (existingPhone) {
            throw new ConflictException('Bu telefon numarası zaten kayıtlı');
        }

        const hashedPassword = await bcrypt.hash(data.password, 10);
        const user = await this.prisma.user.create({
            data: {
                firstName: data.firstName,
                lastName: data.lastName,
                email: data.email,
                phone: normalizedPhone,
                password: hashedPassword,
                role: 'CUSTOMER', // ALWAYS CUSTOMER — role is never accepted from client
            },
        });

        const { password, ...result } = user;
        return result;
    }
    async getProfile(userId: number) {
        // Fetch fresh user data from DB (excluding password)
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                phone: true,
                role: true,
            },
        });
        return user;
    }
    generateGuestToken(jobId: number) {
        // Short-lived token for guest job session
        const payload = { sub: 'guest', role: 'GUEST', jobId };
        // 2 hours expiry for guest session
        return this.jwtService.sign(payload, { expiresIn: '2h' });
    }

    async requestOtpStub(data: { phone: string; email?: string }) {
        // Stub implementation for OTP request
        console.log(`[AUTH-STUB] OTP Requested. Phone: ${data.phone}, Email: ${data.email}`);
        return { success: true, message: 'OTP sent (stub)' };
    }
}
