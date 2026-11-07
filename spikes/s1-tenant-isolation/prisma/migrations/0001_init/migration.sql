-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('OWNER', 'ADMIN', 'SALES_MANAGER', 'SALES_EXECUTIVE', 'HR_OPS');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "team_role" AS ENUM ('MEMBER', 'LEAD');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_membership" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_code" "membership_role" NOT NULL,
    "status" "membership_status" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "organization_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_membership" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "team_role" "team_role" NOT NULL DEFAULT 'MEMBER',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "team_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "primary_phone_e164" TEXT NOT NULL,
    "owner_user_id" UUID,
    "team_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignment_history" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "source" TEXT NOT NULL,

    CONSTRAINT "lead_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "delegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "assignee_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interaction" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "webhook_token_hash" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_link" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "share_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role_code" "membership_role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "organization_membership_org_id_status_idx" ON "organization_membership"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_membership_org_id_id_key" ON "organization_membership"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_membership_org_id_user_id_key" ON "organization_membership"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_org_id_id_key" ON "team"("org_id", "id");

-- CreateIndex
CREATE INDEX "team_membership_org_id_membership_id_idx" ON "team_membership"("org_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_membership_org_id_id_key" ON "team_membership"("org_id", "id");

-- CreateIndex
CREATE INDEX "lead_org_id_created_at_id_idx" ON "lead"("org_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "lead_org_id_owner_user_id_idx" ON "lead"("org_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_org_id_id_key" ON "lead"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_assignment_history_org_id_id_key" ON "lead_assignment_history"("org_id", "id");

-- CreateIndex
CREATE INDEX "delegation_org_id_to_user_id_idx" ON "delegation"("org_id", "to_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "delegation_org_id_id_key" ON "delegation"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_org_id_id_key" ON "task"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "interaction_org_id_id_key" ON "interaction"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_job_org_id_id_key" ON "import_job"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_import_job_id_row_number_key" ON "import_row"("import_job_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_webhook_token_hash_key" ON "integration_connection"("webhook_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_org_id_id_key" ON "integration_connection"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "share_link_token_hash_key" ON "share_link"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "share_link_org_id_id_key" ON "share_link"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_org_id_id_key" ON "invitation"("org_id", "id");

-- CreateIndex
CREATE INDEX "audit_log_org_id_occurred_at_idx" ON "audit_log"("org_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_membership" ADD CONSTRAINT "team_membership_org_id_team_id_fkey" FOREIGN KEY ("org_id", "team_id") REFERENCES "team"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_membership" ADD CONSTRAINT "team_membership_org_id_membership_id_fkey" FOREIGN KEY ("org_id", "membership_id") REFERENCES "organization_membership"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_org_id_owner_user_id_fkey" FOREIGN KEY ("org_id", "owner_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_org_id_team_id_fkey" FOREIGN KEY ("org_id", "team_id") REFERENCES "team"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_org_id_from_user_id_fkey" FOREIGN KEY ("org_id", "from_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_org_id_to_user_id_fkey" FOREIGN KEY ("org_id", "to_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_org_id_assignee_user_id_fkey" FOREIGN KEY ("org_id", "assignee_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_org_id_import_job_id_fkey" FOREIGN KEY ("org_id", "import_job_id") REFERENCES "import_job"("org_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

