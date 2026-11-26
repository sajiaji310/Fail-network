import { LoginForm } from './login-form';
import { safeNextPath } from '@/lib/console-session';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-[380px] rounded-[12px] border border-border bg-surface px-6 py-7 shadow-card">
        <p className="font-mono text-[10.5px] tracking-wide text-text-tertiary">NETSCOPE</p>
        <h1 className="mt-2 text-[18px] font-medium text-text">进入控制台</h1>
        <p className="mt-1 mb-5 text-[12.5px] leading-5 text-text-secondary">
          生产环境用口令换一次登录，12 小时内不用再输。本地开发不走这道门。
        </p>
        <LoginForm next={safeNextPath(next)} />
      </section>
    </main>
  );
}
