-- Alert 补租户快照，并把外部键唯一约束从全局改成租户内。
-- 已有行 tenantId 回填为 default。不删除数据。
-- PostgreSQL 对可空列的唯一索引允许多个 NULL，没有 externalKey 的告警不受影响。

ALTER TABLE "Alert" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';

ALTER TABLE "Alert" DROP CONSTRAINT IF EXISTS "Alert_externalKey_key";
DROP INDEX IF EXISTS "Alert_externalKey_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Alert_tenantId_externalKey_key"
  ON "Alert" ("tenantId", "externalKey");

CREATE INDEX IF NOT EXISTS "Alert_tenantId_status_lastSeen_idx"
  ON "Alert" ("tenantId", "status", "lastSeen");
