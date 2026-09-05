-- CreateTable
CREATE TABLE "sso_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" TEXT NOT NULL,
    "auth_endpoint" TEXT,
    "token_endpoint" TEXT,
    "jwks_uri" TEXT,
    "discovered_at" TIMESTAMP(3),
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultRole" "MemberRole" NOT NULL DEFAULT 'READ_ONLY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_states" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "redirect_to" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sso_connections_tenant_id_key" ON "sso_connections"("tenant_id");

-- CreateIndex
CREATE INDEX "sso_states_expires_at_idx" ON "sso_states"("expires_at");

-- AddForeignKey
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
