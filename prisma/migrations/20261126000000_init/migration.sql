-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('ROUTER', 'SWITCH', 'FIREWALL', 'LOAD_BALANCER', 'SERVER', 'ACCESS_POINT', 'LINK');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'SUPPRESSED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ANALYZING', 'LOCATED', 'MITIGATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LinkStatus" AS ENUM ('UP', 'DOWN', 'DEGRADED');

-- CreateEnum
CREATE TYPE "CaseVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "IngestBatchStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "vendor" TEXT,
    "model" TEXT,
    "ip" TEXT,
    "site" TEXT,
    "layer" INTEGER NOT NULL DEFAULT 3,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAlias" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'push',
    "labels" JSONB,
    "tenantId" TEXT NOT NULL DEFAULT 'default',

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestBatch" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'json',
    "status" "IngestBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "deduped" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "retroSuppressed" INTEGER NOT NULL DEFAULT 0,
    "autoClosedIncidents" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB,
    "error" TEXT,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "IngestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopologyLink" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "bandwidth" INTEGER,
    "status" "LinkStatus" NOT NULL DEFAULT 'UP',

    CONSTRAINT "TopologyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertFingerprint" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metric" TEXT,
    "severity" "Severity" NOT NULL,

    CONSTRAINT "AlertFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "severity" "Severity" NOT NULL,
    "value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "message" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "cycleStart" TIMESTAMP(3) NOT NULL,
    "externalKey" TEXT,
    "raw" JSONB,
    "incidentId" TEXT,
    "suppressedByAlertId" TEXT,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRecord" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "operator" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "Severity" NOT NULL,
    "summary" TEXT,
    "impactScope" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "mttrSeconds" INTEGER,
    "clusterKey" TEXT,
    "mergedIntoId" TEXT,
    "reopenedFromId" TEXT,
    "splitFromId" TEXT,
    "assignee" TEXT,
    "team" TEXT,
    "claimedAt" TIMESTAMP(3),
    "slaMinutes" INTEGER,
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "closedReason" TEXT,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "analysisMeta" JSONB,
    "statusLog" JSONB,
    "closure" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hypothesis" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "cause" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "verifySteps" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "model" TEXT,
    "tokensUsed" INTEGER,
    "verdict" TEXT,
    "verdictAt" TIMESTAMP(3),
    "verdictNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HypothesisVerify" (
    "id" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepText" TEXT NOT NULL,
    "note" TEXT,
    "by" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HypothesisVerify_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 2,
    "owner" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceDevice" (
    "serviceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "role" TEXT,

    CONSTRAINT "ServiceDevice_pkey" PRIMARY KEY ("serviceId","deviceId")
);

-- CreateTable
CREATE TABLE "CaseRecord" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "symptom" TEXT NOT NULL,
    "rootCause" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "tags" TEXT[],
    "verification" "CaseVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verifyNote" TEXT,
    "embedding" TEXT,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "target" TEXT,
    "result" TEXT NOT NULL,
    "detail" JSONB,
    "requestId" TEXT,
    "ip" TEXT,
    "tenantId" TEXT NOT NULL DEFAULT 'default',

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Device_type_site_idx" ON "Device"("type", "site");

-- CreateIndex
CREATE INDEX "Device_tenantId_idx" ON "Device"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_name_key" ON "Device"("tenantId", "name");

-- CreateIndex
CREATE INDEX "DeviceAlias_deviceId_idx" ON "DeviceAlias"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAlias_tenantId_alias_key" ON "DeviceAlias"("tenantId", "alias");

-- CreateIndex
CREATE INDEX "MetricSample_deviceId_metric_at_idx" ON "MetricSample"("deviceId", "metric", "at");

-- CreateIndex
CREATE INDEX "MetricSample_at_idx" ON "MetricSample"("at");

-- CreateIndex
CREATE UNIQUE INDEX "MetricSample_deviceId_metric_at_source_key" ON "MetricSample"("deviceId", "metric", "at", "source");

-- CreateIndex
CREATE INDEX "IngestBatch_createdAt_idx" ON "IngestBatch"("createdAt");

-- CreateIndex
CREATE INDEX "IngestBatch_status_createdAt_idx" ON "IngestBatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IngestBatch_tenantId_createdAt_idx" ON "IngestBatch"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "TopologyLink_sourceId_idx" ON "TopologyLink"("sourceId");

-- CreateIndex
CREATE INDEX "TopologyLink_targetId_idx" ON "TopologyLink"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "TopologyLink_sourceId_targetId_key" ON "TopologyLink"("sourceId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertFingerprint_signature_key" ON "AlertFingerprint"("signature");

-- CreateIndex
CREATE INDEX "AlertFingerprint_deviceId_type_idx" ON "AlertFingerprint"("deviceId", "type");

-- CreateIndex
CREATE INDEX "Alert_tenantId_status_lastSeen_idx" ON "Alert"("tenantId", "status", "lastSeen");

-- CreateIndex
CREATE INDEX "Alert_status_lastSeen_idx" ON "Alert"("status", "lastSeen");

-- CreateIndex
CREATE INDEX "Alert_incidentId_idx" ON "Alert"("incidentId");

-- CreateIndex
CREATE INDEX "Alert_suppressedByAlertId_idx" ON "Alert"("suppressedByAlertId");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_fingerprintId_cycleStart_key" ON "Alert"("fingerprintId", "cycleStart");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_tenantId_externalKey_key" ON "Alert"("tenantId", "externalKey");

-- CreateIndex
CREATE INDEX "ChangeRecord_deviceId_changedAt_idx" ON "ChangeRecord"("deviceId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_clusterKey_key" ON "Incident"("clusterKey");

-- CreateIndex
CREATE INDEX "Incident_status_startedAt_idx" ON "Incident"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Incident_severity_idx" ON "Incident"("severity");

-- CreateIndex
CREATE INDEX "Incident_tenantId_status_startedAt_idx" ON "Incident"("tenantId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "Incident_assignee_status_idx" ON "Incident"("assignee", "status");

-- CreateIndex
CREATE INDEX "Incident_claimedAt_idx" ON "Incident"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_tenantId_code_key" ON "Incident"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Hypothesis_incidentId_rank_idx" ON "Hypothesis"("incidentId", "rank");

-- CreateIndex
CREATE INDEX "HypothesisVerify_hypothesisId_at_idx" ON "HypothesisVerify"("hypothesisId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "HypothesisVerify_hypothesisId_stepIndex_key" ON "HypothesisVerify"("hypothesisId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Service_code_key" ON "Service"("code");

-- CreateIndex
CREATE INDEX "Service_tier_idx" ON "Service"("tier");

-- CreateIndex
CREATE INDEX "ServiceDevice_deviceId_idx" ON "ServiceDevice"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseRecord_incidentId_key" ON "CaseRecord"("incidentId");

-- CreateIndex
CREATE INDEX "CaseRecord_title_idx" ON "CaseRecord"("title");

-- CreateIndex
CREATE INDEX "CaseRecord_verification_createdAt_idx" ON "CaseRecord"("verification", "createdAt");

-- CreateIndex
CREATE INDEX "CaseRecord_tenantId_createdAt_idx" ON "CaseRecord"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_at_idx" ON "AuditLog"("tenantId", "at");

-- CreateIndex
CREATE INDEX "Report_incidentId_idx" ON "Report"("incidentId");

-- AddForeignKey
ALTER TABLE "DeviceAlias" ADD CONSTRAINT "DeviceAlias_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopologyLink" ADD CONSTRAINT "TopologyLink_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopologyLink" ADD CONSTRAINT "TopologyLink_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertFingerprint" ADD CONSTRAINT "AlertFingerprint_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "AlertFingerprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_suppressedByAlertId_fkey" FOREIGN KEY ("suppressedByAlertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRecord" ADD CONSTRAINT "ChangeRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HypothesisVerify" ADD CONSTRAINT "HypothesisVerify_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "Hypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDevice" ADD CONSTRAINT "ServiceDevice_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDevice" ADD CONSTRAINT "ServiceDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecord" ADD CONSTRAINT "CaseRecord_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

