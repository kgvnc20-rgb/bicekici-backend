/*
  Warnings:

  - You are about to drop the column `truckType` on the `DriverApplication` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DriverApplication" DROP COLUMN "truckType",
ADD COLUMN     "capabilities" TEXT[];
