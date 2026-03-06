import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import * as crypto from 'crypto';

const REFRESH_TOKEN_EXPIRY_DAYS = 30;

@Injectable()
export class TokenService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
    ) { }

    /**
     * Issue an access + refresh token pair.
     * Access token: 15min, contains userId/role/phone/sessionVersion.
     * Refresh token: 30 days, device-bound, stored as SHA-256 hash in DB.
     */
    async issueTokenPair(
        user: { id: number; email?: string | null; phone?: string | null; role: string; sessionVersion: number },
        deviceId: string,
        deviceName?: string,
    ) {
        // ── Access Token (short-lived) ──
        const accessPayload = {
            sub: user.id,
            email: user.email,
            phone: user.phone,
            role: user.role,
            sessionVersion: user.sessionVersion,
        };
        const accessToken = this.jwtService.sign(accessPayload, { expiresIn: '15m' });

        // ── Refresh Token (long-lived, device-bound) ──
        const refreshToken = crypto.randomBytes(48).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        await this.prisma.refreshToken.create({
            data: {
                userId: user.id,
                tokenHash,
                deviceId,
                deviceName: deviceName || null,
                expiresAt,
            },
        });

        console.log(`🔑 [Token] Issued token pair for user #${user.id} on device ${deviceId.substring(0, 8)}...`);

        return {
            accessToken,
            refreshToken,
            expiresIn: 900, // 15 minutes in seconds
        };
    }

    /**
     * Rotate refresh token: revoke old, issue new pair.
     * Validates: token exists, not revoked, not expired, device matches.
     */
    async refreshTokens(oldRefreshToken: string, deviceId: string) {
        const tokenHash = crypto.createHash('sha256').update(oldRefreshToken).digest('hex');

        const stored = await this.prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });

        if (!stored) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        if (stored.revokedAt) {
            // Token was already rotated → possible theft. Revoke ALL tokens for this user.
            console.warn(`⚠️ [Token] Replay detected for user #${stored.userId} — revoking all sessions`);
            await this.prisma.refreshToken.updateMany({
                where: { userId: stored.userId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            throw new UnauthorizedException('Token reuse detected — all sessions revoked');
        }

        if (stored.expiresAt < new Date()) {
            throw new UnauthorizedException('Refresh token expired');
        }

        if (stored.deviceId !== deviceId) {
            throw new UnauthorizedException('Device mismatch');
        }

        // Revoke old token
        await this.prisma.refreshToken.update({
            where: { id: stored.id },
            data: { revokedAt: new Date() },
        });

        // Issue new pair
        return this.issueTokenPair(stored.user, deviceId, stored.deviceName);
    }

    /**
     * Revoke sessions for a user. If deviceId provided, revoke only that device.
     * Otherwise revoke all.
     */
    async revokeSessions(userId: number, deviceId?: string) {
        const where: any = { userId, revokedAt: null };
        if (deviceId) where.deviceId = deviceId;

        const result = await this.prisma.refreshToken.updateMany({
            where,
            data: { revokedAt: new Date() },
        });

        console.log(`🔒 [Token] Revoked ${result.count} session(s) for user #${userId}${deviceId ? ` on device ${deviceId.substring(0, 8)}...` : ''}`);
        return { revoked: result.count };
    }

    /**
     * List active sessions for a user.
     */
    async listSessions(userId: number) {
        const sessions = await this.prisma.refreshToken.findMany({
            where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
            select: {
                deviceId: true,
                deviceName: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        return { sessions };
    }

    /**
     * Increment sessionVersion for a user → invalidates all existing JWTs.
     */
    async incrementSessionVersion(userId: number) {
        await this.prisma.user.update({
            where: { id: userId },
            data: { sessionVersion: { increment: 1 } },
        });
        console.log(`🔄 [Token] Incremented sessionVersion for user #${userId}`);
    }
}
