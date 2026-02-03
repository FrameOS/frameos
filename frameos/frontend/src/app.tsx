export function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-900 px-6 text-center">
      <div className="rounded-full bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-200">
        FrameOS Device UI
      </div>
      <div className="max-w-2xl space-y-3">
        <h1 className="text-3xl font-semibold text-slate-50 sm:text-4xl">Frame control is moving onboard</h1>
        <p className="text-base text-slate-200 sm:text-lg">
          This interface is compiled for the frame runtime and served directly from the device at{' '}
          <span className="font-semibold text-white">/new</span>.
        </p>
      </div>
      <div className="flex flex-col gap-2 text-sm text-slate-300">
        <span className="rounded-lg bg-slate-800/70 px-3 py-1">Live status and controls will land here.</span>
        <span className="rounded-lg bg-slate-800/70 px-3 py-1">Built with React + esbuild for lightweight delivery.</span>
      </div>
    </div>
  )
}
