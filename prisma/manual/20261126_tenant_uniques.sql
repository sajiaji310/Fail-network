-- 设备名、别名、事件编号从全局唯一改成租户内唯一。
-- 不删数据。已有行都在 default 租户，旧的全局唯一值换到复合唯一后仍然不撞。
-- 不要用 db push：它会把「删掉旧唯一索引、建新的」误报成数据丢失。

ALTER TABLE "Device" DROP CONSTRAINT IF EXISTS "Device_name_key";
DROP INDEX IF EXISTS "Device_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Device_tenantId_name_key"
  ON "Device" ("tenantId", "name");

ALTER TABLE "DeviceAlias" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "DeviceAlias" DROP CONSTRAINT IF EXISTS "DeviceAlias_alias_key";
DROP INDEX IF EXISTS "DeviceAlias_alias_key";
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceAlias_tenantId_alias_key"
  ON "DeviceAlias" ("tenantId", "alias");

ALTER TABLE "Incident" DROP CONSTRAINT IF EXISTS "Incident_code_key";
DROP INDEX IF EXISTS "Incident_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_tenantId_code_key"
  ON "Incident" ("tenantId", "code");
