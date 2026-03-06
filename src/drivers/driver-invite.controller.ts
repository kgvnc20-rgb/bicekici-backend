import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { DriverInviteService } from './driver-invite.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

class SetPinDto {
    @IsString()
    @Matches(/^\d{6}$/, { message: 'PIN 6 haneli bir sayı olmalıdır' })
    pin!: string;
}

@ApiTags('Driver Invites')
@Controller('driver-invites')
export class DriverInviteController {
    constructor(private readonly inviteService: DriverInviteService) { }

    @Get(':token/validate')
    @ApiOperation({ summary: 'Validate an invite token (check if usable)' })
    async validate(@Param('token') token: string) {
        return this.inviteService.validateToken(token);
    }

    @Post(':token/set-pin')
    @ApiOperation({ summary: 'Set 6-digit PIN using invite token' })
    async setPin(@Param('token') token: string, @Body() dto: SetPinDto) {
        return this.inviteService.setPin(token, dto.pin);
    }
}
