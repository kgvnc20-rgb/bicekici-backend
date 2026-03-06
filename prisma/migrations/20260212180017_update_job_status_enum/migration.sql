/*
  Warnings:

  - The values [PENDING] on the enum `JobStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "JobStatus_new" AS ENUM ('PRICED', 'PAID', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" TYPE "JobStatus_new" USING ("status"::text::"JobStatus_new");
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";
ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
DROP TYPE "JobStatus_old";
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" SET DEFAULT 'PRICED';
COMMIT;

-- AlterTable
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" SET DEFAULT 'PRICED';
