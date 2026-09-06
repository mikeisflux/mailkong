-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sending_ip" TEXT;

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "spam_score" DOUBLE PRECISION,
    "size_bytes" INTEGER,
    "preview" TEXT,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "stripe_coupon_id" TEXT,
    "description" TEXT,
    "percent_off" INTEGER,
    "amount_off_cents" INTEGER,
    "duration_months" INTEGER,
    "max_redemptions" INTEGER,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbound_messages_tenant_id_created_at_idx" ON "inbound_messages"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "inbound_messages_route_id_created_at_idx" ON "inbound_messages"("route_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "messages_sending_ip_created_at_idx" ON "messages"("sending_ip", "created_at");

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "inbound_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
