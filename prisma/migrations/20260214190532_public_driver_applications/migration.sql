/*
  Warnings:

  - A unique constraint covering the columns `[uploadToken]` on the table `DriverApplication` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "DriverApplication" DROP CONSTRAINT "DriverApplication_userId_fkey";

-- AlterTable
ALTER TABLE "DriverApplication" ADD COLUMN     "uploadToken" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DriverApplication_uploadToken_key" ON "DriverApplication"("uploadToken");

-- AddForeignKey
ALTER TABLE "DriverApplication" ADD CONSTRAINT "DriverApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
