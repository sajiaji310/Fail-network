/**
 * 本地便携版 PostgreSQL 管理（T01 环境方案）
 * 用法：node scripts/db.mjs <start|stop|status|restart>
 * Docker 用户不需要这个脚本，直接 docker compose up -d db
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PG_HOME = process.env.PG_HOME ?? 'E:/sinxiangmy/.tools/pg16';
const PGDATA = process.env.PGDATA ?? 'E:/sinxiangmy/.tools/pgdata';
const PGPORT = process.env.PGPORT ?? '5432';

const bin = (name) => path.join(PG_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name);

function run(name, args) {
  return spawnSync(bin(name), args, { stdio: 'inherit' });
}

const cmd = process.argv[2] ?? 'status';

if (!existsSync(PGDATA)) {
  console.error(`[db] 数据目录不存在：${PGDATA}（先设置 .env 里的 PGDATA）`);
  process.exit(1);
}

switch (cmd) {
  case 'start': {
    const status = spawnSync(bin('pg_ctl'), ['-D', PGDATA, 'status']);
    if (status.status === 0) {
      console.log('[db] 已在运行');
      break;
    }
    run('pg_ctl', ['-D', PGDATA, '-l', path.join(PGDATA, '..', 'pg.log'), '-o', `-p ${PGPORT}`, 'start']);
    run('pg_isready', ['-h', '127.0.0.1', '-p', PGPORT]);
    break;
  }
  case 'stop':
    run('pg_ctl', ['-D', PGDATA, 'stop', '-m', 'fast']);
    break;
  case 'restart':
    run('pg_ctl', ['-D', PGDATA, 'restart', '-m', 'fast', '-o', `-p ${PGPORT}`]);
    break;
  case 'status':
    run('pg_ctl', ['-D', PGDATA, 'status']);
    run('pg_isready', ['-h', '127.0.0.1', '-p', PGPORT]);
    break;
  default:
    console.error(`未知命令：${cmd}（start|stop|restart|status）`);
    process.exit(1);
}
