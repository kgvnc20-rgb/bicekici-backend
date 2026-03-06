-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "dropoffPlaceId" TEXT,
ADD COLUMN     "pickupPlaceId" TEXT,
ADD COLUMN     "routePolyline" TEXT;

-- CreateTable
CREATE TABLE "PricingConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "baseFare" DECIMAL(10,2) NOT NULL,
    "perKmRate" DECIMAL(10,2) NOT NULL,
    "minFare" DECIMAL(10,2) NOT NULL,
    "vehicleMultiplierCar" DECIMAL(3,2) NOT NULL,
    "vehicleMultiplierSuv" DECIMAL(3,2) NOT NULL,
    "vehicleMultiplierMoto" DECIMAL(3,2) NOT NULL,
    "morningPeakStart" TEXT NOT NULL,
    "morningPeakEnd" TEXT NOT NULL,
    "morningPeakMultiplier" DECIMAL(3,2) NOT NULL,
    "eveningPeakStart" TEXT NOT NULL,
    "eveningPeakEnd" TEXT NOT NULL,
    "eveningPeakMultiplier" DECIMAL(3,2) NOT NULL,
    "nightStart" TEXT NOT NULL,
    "nightEnd" TEXT NOT NULL,
    "nightMultiplier" DECIMAL(3,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingConfig_pkey" PRIMARY KEY ("id")
);
