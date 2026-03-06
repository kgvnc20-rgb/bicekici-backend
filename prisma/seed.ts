
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding default pricing config...');

    await prisma.pricingConfig.upsert({
        where: { id: 'default' },
        update: {},
        create: {
            id: 'default',
            baseFare: 500.00,
            perKmRate: 20.00,
            minFare: 800.00,

            vehicleMultiplierCar: 1.00,
            vehicleMultiplierSuv: 1.25,
            vehicleMultiplierMoto: 0.80,

            morningPeakStart: "07:00",
            morningPeakEnd: "10:00",
            morningPeakMultiplier: 1.15,

            eveningPeakStart: "17:00",
            eveningPeakEnd: "20:00",
            eveningPeakMultiplier: 1.20,

            nightStart: "23:00",
            nightEnd: "06:00",
            nightMultiplier: 1.50,
        },
    });

    console.log('Pricing config seeded.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
