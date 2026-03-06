-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELED');

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "currentWave" INTEGER DEFAULT 0,
ADD COLUMN     "dispatchStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "JobOffer" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "driverId" INTEGER NOT NULL,
    "wave" INTEGER NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "JobOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_job_status_idx" ON "JobOffer"("jobId", "status");

-- CreateIndex
CREATE INDEX "offer_driver_status_idx" ON "JobOffer"("driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobOffer_jobId_driverId_wave_key" ON "JobOffer"("jobId", "driverId", "wave");

-- AddForeignKey
ALTER TABLE "JobOffer" ADD CONSTRAINT "JobOffer_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
