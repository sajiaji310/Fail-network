'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';

/**
 * 设备别名录入（数据源页）。
 *
 * 只做一件事：把上游主机名绑到已有设备上。设备必须已存在 —— 这里不提供"顺便创建设备"，
 * 因为自动创建设备会把拼写错误变成永久脏数据（`core-sw-o1` 看起来和真的没区别）。
 */
export function AliasForm({ devices }: { devices: { id: string; name: string }[] }) {
  const router = useRouter();
  const [alias, setAlias] = useState('');
  const [deviceName, setDeviceName] = useState(devices[0]?.name ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch('/api/v1/sources/aliases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias, deviceName }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } };
        setError(body?.error?.message ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      setOk(`已绑定 ${alias} → ${deviceName}`);
      setAlias('');
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5">
      <input
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        placeholder="上游主机名，如 core-sw-01.lab 或 10.1.0.1"
        className="h-8 w-[248px] rounded-[7px] border border-border-strong bg-surface px-2 font-mono text-[11.5px] outline-none placeholder:font-sans placeholder:text-text-tertiary focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-ring)]"
        required
      />
      <span className="text-[11px] text-text-tertiary">→</span>
      <select
        value={deviceName}
        onChange={(e) => setDeviceName(e.target.value)}
        className="h-8 rounded-[7px] border border-border-strong bg-surface px-2 text-[11.5px] outline-none focus:border-primary"
      >
        {devices.map((device) => (
          <option key={device.id} value={device.name}>
            {device.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || devices.length === 0}
        className={buttonClass({ variant: 'secondary', size: 'sm' })}
      >
        <Plus size={11} strokeWidth={2} />
        {pending ? '保存中…' : '添加别名'}
      </button>
      {error ? <span className="text-[10.5px] text-danger">{error}</span> : null}
      {ok ? <span className="text-[10.5px] text-ok">{ok}</span> : null}
    </form>
  );
}
