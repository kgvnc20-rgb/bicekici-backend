import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface PriceEstimate {
    estimatedPrice: number;
    breakdown: {
        baseFee: number;
        distanceKm: number;
        pricePerKm: number;
        vehicleMultiplier: number;
        subtotal: number;
    };
}

@Injectable()
export class PricingService {
    constructor(private prisma: PrismaService) { }

    async getPricingConfig() {
        // Singleton config
        let config = await this.prisma.pricingConfig.findUnique({ where: { id: 'default' } });
        if (!config) {
            // Fallback (should be seeded)
            throw new Error('Pricing config not found');
        }
        return config;
    }

    async updatePricingConfig(data: any) {
        return this.prisma.pricingConfig.update({
            where: { id: 'default' },
            data,
        });
    }

    async calculateQuote(distanceKm: number, durationMin: number, vehicleType: string): Promise<any> {
        const config = await this.getPricingConfig();

        const baseFare = Number(config.baseFare);
        const pricePerKm = Number(config.perKmRate);
        const minFare = Number(config.minFare);

        // 1. Vehicle Multiplier
        let vehicleMultiplier = 1.0;
        switch (vehicleType.toUpperCase()) {
            case 'SUV': vehicleMultiplier = Number(config.vehicleMultiplierSuv); break;
            case 'MOTO': vehicleMultiplier = Number(config.vehicleMultiplierMoto); break;
            case 'CAR':
            default: vehicleMultiplier = Number(config.vehicleMultiplierCar); break;
        }

        // 2. Time Multiplier
        let timeMultiplier = 1.0;
        const now = new Date();
        const currentHour = now.getHours();
        const currentMin = now.getMinutes();
        const currentTime = currentHour + (currentMin / 60);

        // Helper to parse "HH:MM" to decimal hours
        const parseTime = (timeStr: string) => {
            const [h, m] = timeStr.split(':').map(Number);
            return h + (m / 60);
        };

        const morningStart = parseTime(config.morningPeakStart);
        const morningEnd = parseTime(config.morningPeakEnd);
        const eveningStart = parseTime(config.eveningPeakStart);
        const eveningEnd = parseTime(config.eveningPeakEnd);
        const nightStart = parseTime(config.nightStart);
        const nightEnd = parseTime(config.nightEnd);

        // Simple check for ranges (assuming start < end for day intervals, start > end for night wrapping)
        const isBetween = (start: number, end: number, current: number) => {
            if (start < end) return current >= start && current < end;
            return current >= start || current < end; // Wrap around midnight
        };

        if (isBetween(morningStart, morningEnd, currentTime)) {
            timeMultiplier = Number(config.morningPeakMultiplier);
        } else if (isBetween(eveningStart, eveningEnd, currentTime)) {
            timeMultiplier = Number(config.eveningPeakMultiplier);
        } else if (isBetween(nightStart, nightEnd, currentTime)) {
            timeMultiplier = Number(config.nightMultiplier);
        }

        // 3. Calculation
        // Formula: (Base + (Dist * Rate)) * Vehicle * Time
        // Min fare applies to the FINAL total? Or Base? Usually final total >= minFare.

        const rawTotal = (baseFare + (distanceKm * pricePerKm)) * vehicleMultiplier * timeMultiplier;
        const finalPrice = Math.max(rawTotal, minFare);

        return {
            distanceKm,
            durationMin,
            finalPrice: Number(finalPrice.toFixed(2)),
            breakdown: {
                baseFare,
                perKmRate: pricePerKm,
                distanceFee: Number((distanceKm * pricePerKm).toFixed(2)),
                vehicleMultiplier,
                timeMultiplier,
                minFare,
                isMinFareApplied: finalPrice === minFare
            }
        };
    }

    // Keep legacy support if needed, or remove. Assuming full replacement as per requirement.
}
