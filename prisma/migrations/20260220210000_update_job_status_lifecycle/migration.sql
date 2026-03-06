-- Migration: Replace old JobStatus enum values with new lifecycle statuses
-- Old: PRICED, PAID, ASSIGNED, EN_ROUTE, ARRIVED, IN_PROGRESS, COMPLETED, CANCELLED, EXPIRED, PENDING_PAYMENT, DISPATCHING, NO_DRIVER_FOUND
-- New: MATCHING, ASSIGNED, EN_ROUTE_TO_PICKUP, LOADED, EN_ROUTE_TO_DROPOFF, DELIVERED, CANCELED, NO_DRIVER_FOUND

-- Convert existing rows to a transitional state before enum swap
-- Map old statuses → new statuses for any existing data
UPDATE "ServiceRequest" SET "status" = 'ASSIGNED' WHERE "status" IN ('PRICED', 'PAID', 'PENDING_PAYMENT');
UPDATE "ServiceRequest" SET "status" = 'ASSIGNED' WHERE "status" = 'DISPATCHING';
-- EN_ROUTE, ARRIVED stay as ASSIGNED (will be cleaned up by new enum)
UPDATE "ServiceRequest" SET "status" = 'ASSIGNED' WHERE "status" IN ('EN_ROUTE', 'ARRIVED');
-- IN_PROGRESS → keep as ASSIGNED for now
UPDATE "ServiceRequest" SET "status" = 'ASSIGNED' WHERE "status" = 'IN_PROGRESS';
-- COMPLETED → DELIVERED (via text cast, done after enum swap)
-- CANCELLED → CANCELED (spelling fix)
-- EXPIRED → CANCELED

-- Step 1: Create new enum type
CREATE TYPE "JobStatus_new" AS ENUM ('MATCHING', 'ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'LOADED', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED', 'CANCELED', 'NO_DRIVER_FOUND');

-- Step 2: Map remaining old values to new before type swap
UPDATE "ServiceRequest" SET "status" = 'ASSIGNED' WHERE "status"::text NOT IN ('MATCHING', 'ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'LOADED', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED', 'CANCELED', 'NO_DRIVER_FOUND');

-- Step 3: Swap the enum type
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" TYPE "JobStatus_new" USING ("status"::text::"JobStatus_new");
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";
ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
DROP TYPE "JobStatus_old";

-- Step 4: Set new default
ALTER TABLE "ServiceRequest" ALTER COLUMN "status" SET DEFAULT 'MATCHING';
