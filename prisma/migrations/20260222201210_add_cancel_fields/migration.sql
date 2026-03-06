-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM');

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" "CancelledBy";
