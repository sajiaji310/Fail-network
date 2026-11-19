export default function IncidentDetailLoading() {
  return (
    <div className="mx-auto max-w-[1500px] animate-pulse">
      <div className="mb-3 h-4 w-24 rounded bg-surface-muted" />
      <div className="mb-4 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="h-4 w-52 rounded bg-surface-muted" />
        <div className="mt-2 h-6 w-[420px] max-w-full rounded bg-surface-muted" />
        <div className="mt-3 flex gap-5">
          {[64, 48, 56, 40, 44].map((w) => (
            <div key={w} className="h-3 rounded bg-surface-muted" style={{ width: w }} />
          ))}
        </div>
      </div>

      <div className="grid min-h-[620px] grid-cols-1 gap-4 xl:grid-cols-[290px_minmax(0,1fr)_324px]">
        <div className="rounded-xl border border-border bg-surface">
          <div className="h-9 border-b border-border" />
          <div className="space-y-3 px-3 py-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="flex gap-2">
                <div className="h-3 w-10 rounded bg-surface-muted" />
                <div className="h-3 flex-1 rounded bg-surface-muted" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border bg-surface">
            <div className="h-9 border-b border-border" />
            <div className="m-2 h-[330px] rounded-[8px] bg-surface-muted" />
          </div>
          <div className="flex-1 rounded-xl border border-border bg-surface" />
        </div>
        <div className="rounded-xl border border-border bg-surface">
          <div className="h-9 border-b border-border" />
          <div className="space-y-2 px-3 py-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-3 rounded bg-surface-muted" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
