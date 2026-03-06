import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../prisma.service';
import { GuestAuthService } from './guest-auth.service';
import { TokenService } from './token.service';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    console.error('⛔ FATAL: JWT_SECRET environment variable is not set. Server cannot start securely.');
    process.exit(1);
}

@Module({
    imports: [
        PassportModule,
        JwtModule.register({
            secret: jwtSecret,
            signOptions: { expiresIn: '15m' },
        }),
        forwardRef(() => JobsModule),
        NotificationsModule,
    ],
    controllers: [AuthController],
    providers: [AuthService, GuestAuthService, TokenService, JwtStrategy, PrismaService],
    exports: [AuthService, GuestAuthService, TokenService],
})
export class AuthModule { }

