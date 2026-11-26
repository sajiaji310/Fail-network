'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui/button';

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/console/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } };
        setError(body?.error?.message ?? `登录失败（HTTP ${res.status}）`);
        return;
      }
      window.location.assign(next);
    } catch {
      setError('登录请求没有发出去');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-[320px] flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-[12px] text-text-secondary">
        口令
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-9 rounded-[8px] border border-border-strong bg-surface px-2.5 text-[13px] text-text outline-none focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-ring)]"
          required
        />
      </label>
      <button
        type="submit"
        disabled={pending || password.length === 0}
        className={buttonClass({ variant: 'primary', size: 'md' })}
      >
        {pending ? '正在进入…' : '进入控制台'}
      </button>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </form>
  );
}
