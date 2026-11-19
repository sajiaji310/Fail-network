import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { getSystemStatus } from '@/modules/system/service';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const status = await getSystemStatus();

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar db={status.db} llm={status.llm} stage={status.stage} />
        <main className="flex-1 px-6 py-5">{children}</main>
      </div>
    </div>
  );
}
