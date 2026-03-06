import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class DriversService {
    constructor(private prisma: PrismaService) { }

    async getProfile(userId: number) {
        return this.prisma.driverProfile.findUnique({
            where: { userId },
        });
    }

    /** Ensure a DriverProfile exists for the user, create if not */
    async ensureProfile(userId: number) {
        return this.prisma.driverProfile.upsert({
            where: { userId },
            create: { userId, isOnline: false },
            update: {},
        });
    }

    async getUserInfo(userId: number) {
        return this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, phone: true, role: true, firstName: true, lastName: true },
        });
    }

    async updateStatus(userId: number, isOnline: boolean) {
        return this.prisma.driverProfile.upsert({
            where: { userId },
            create: { userId, isOnline },
            update: { isOnline },
        });
    }

    async updateLocation(userId: number, lat: number, lng: number) {
        await this.prisma.driverProfile.upsert({
            where: { userId },
            create: { userId, currentLat: lat, currentLng: lng, isOnline: true },
            update: { currentLat: lat, currentLng: lng },
        });

        return { success: true };
    }

    async findNearestDrivers(lat: number, lng: number, radiusKm: number = 25, limit: number = 10) {
        const drivers = await this.prisma.$queryRaw<{ id: number; userId: number; distance: number }[]>`
            SELECT 
                d.id, 
                d."userId", 
                (
                    6371000 * acos(
                        LEAST(1.0, cos(radians(${lat})) * cos(radians(CAST(d."currentLat" AS double precision)))
                        * cos(radians(CAST(d."currentLng" AS double precision)) - radians(${lng}))
                        + sin(radians(${lat})) * sin(radians(CAST(d."currentLat" AS double precision))))
                    )
                ) as distance
            FROM "DriverProfile" d
            WHERE d."isOnline" = true
              AND d."currentLat" IS NOT NULL
              AND d."currentLng" IS NOT NULL
              AND (
                    6371000 * acos(
                        LEAST(1.0, cos(radians(${lat})) * cos(radians(CAST(d."currentLat" AS double precision)))
                        * cos(radians(CAST(d."currentLng" AS double precision)) - radians(${lng}))
                        + sin(radians(${lat})) * sin(radians(CAST(d."currentLat" AS double precision))))
                    )
                  ) <= ${radiusKm * 1000}
            ORDER BY distance ASC
            LIMIT ${limit};
        `;

        return drivers;
    }

    async updateDriver(id: number, data: { fullName?: string; plate?: string; isActive?: boolean; commissionRate?: number }) {
        const profile = await this.prisma.driverProfile.findUnique({ where: { id } });
        if (!profile) throw new NotFoundException('Driver not found');

        // Update User name if provided
        if (data.fullName) {
            const parts = data.fullName.trim().split(/\s+/);
            const firstName = parts[0];
            const lastName = parts.slice(1).join(' ') || '';
            await this.prisma.user.update({
                where: { id: profile.userId },
                data: { firstName, lastName },
            });
        }

        // Update DriverProfile
        const updateData: any = {};
        if (data.plate) updateData.licenseNumber = data.plate;
        if (data.isActive !== undefined) updateData.isActive = data.isActive;
        if (data.commissionRate !== undefined) updateData.commissionRate = data.commissionRate;

        // If deactivating, also set offline
        if (data.isActive === false) {
            updateData.isOnline = false;
        }

        return this.prisma.driverProfile.update({
            where: { id },
            data: updateData,
            include: { user: true },
        });
    }

    async getAllDrivers() {
        return this.prisma.driverProfile.findMany({
            include: {
                user: { select: { id: true, email: true, phone: true, firstName: true, lastName: true } },
            },
            orderBy: { id: 'asc' },
        });
    }
}
