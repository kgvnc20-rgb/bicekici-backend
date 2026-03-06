-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- AlterTable
ALTER TABLE "DriverProfile" ADD COLUMN     "location" geography(Point, 4326);

-- CreateIndex
CREATE INDEX "location_idx" ON "DriverProfile" USING GIST ("location");
