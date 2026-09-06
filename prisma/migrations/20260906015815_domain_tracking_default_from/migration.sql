-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "default_from" TEXT,
ADD COLUMN     "tracking_enabled" BOOLEAN NOT NULL DEFAULT false;
