import { Module, forwardRef } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { AuthModule } from '../auth/auth.module';
import { DriversModule } from '../drivers/drivers.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
    imports: [
        forwardRef(() => AuthModule),
        forwardRef(() => DriversModule),
        JwtModule.register({
            secret: process.env.JWT_SECRET,
            signOptions: { expiresIn: '60m' },
        }),
    ],
    providers: [RealtimeGateway],
    exports: [RealtimeGateway],
})
export class RealtimeModule { }
