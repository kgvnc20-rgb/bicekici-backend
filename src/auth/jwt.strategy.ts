import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(private prisma: PrismaService) {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            throw new Error('JWT_SECRET environment variable is not set');
        }
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: secret,
        });
    }

    async validate(payload: any) {
        // Guest tokens don't have sessionVersion — allow through
        if (payload.sub === 'guest') {
            return { userId: payload.sub, role: payload.role, jobId: payload.jobId };
        }

        // Validate sessionVersion against DB (catches force-logout)
        if (payload.sessionVersion !== undefined) {
            const user = await this.prisma.user.findUnique({
                where: { id: payload.sub },
                select: { sessionVersion: true },
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            if (user.sessionVersion !== payload.sessionVersion) {
                throw new UnauthorizedException('Session invalidated — please re-authenticate');
            }
        }

        return {
            userId: payload.sub,
            email: payload.email,
            phone: payload.phone,
            role: payload.role,
            jobId: payload.jobId,
        };
    }
}
