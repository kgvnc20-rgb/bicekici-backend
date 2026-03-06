import { Injectable, NotFoundException, BadRequestException, GoneException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class DriverInviteService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Validate an invite token (used by the set-pin page to show status before submission).
     */
    async validateToken(token: string) {
        const invite = await this.prisma.driverInviteToken.findUnique({
            where: { token },
            include: { user: { select: { id: true, firstName: true, email: true } } },
        });

        if (!invite) {
            throw new NotFoundException('Bu davet bağlantısı geçersiz.');
        }
        if (invite.usedAt) {
            throw new GoneException('Bu davet bağlantısı zaten kullanılmış. PIN\'inizi zaten ayarladınız.');
        }
        if (invite.expiresAt < new Date()) {
            throw new GoneException('Bu davet bağlantısının süresi dolmuş. Lütfen yönetici ile iletişime geçin.');
        }

        return { valid: true, firstName: invite.user.firstName };
    }

    /**
     * Set a 6-digit PIN for a driver using their invite token.
     * - Validates token (exists, not used, not expired)
     * - Validates PIN format (exactly 6 digits)
     * - bcrypt-hashes PIN and stores as user password
     * - Marks token as used
     */
    async setPin(token: string, pin: string) {
        // Validate PIN format
        if (!pin || !/^\d{6}$/.test(pin)) {
            throw new BadRequestException('PIN 6 haneli bir sayı olmalıdır.');
        }

        const invite = await this.prisma.driverInviteToken.findUnique({
            where: { token },
            include: { user: true },
        });

        if (!invite) {
            throw new NotFoundException('Bu davet bağlantısı geçersiz.');
        }
        if (invite.usedAt) {
            throw new GoneException('Bu davet bağlantısı zaten kullanılmış. PIN\'inizi zaten ayarladınız.');
        }
        if (invite.expiresAt < new Date()) {
            throw new GoneException('Bu davet bağlantısının süresi dolmuş. Lütfen yönetici ile iletişime geçin.');
        }

        // Hash PIN and update user password + mark token used
        const hashedPin = await bcrypt.hash(pin, 10);

        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: invite.userId },
                data: { password: hashedPin },
            }),
            this.prisma.driverInviteToken.update({
                where: { id: invite.id },
                data: { usedAt: new Date() },
            }),
        ]);

        return { success: true, message: 'PIN başarıyla ayarlandı. Artık giriş yapabilirsiniz.' };
    }
}
