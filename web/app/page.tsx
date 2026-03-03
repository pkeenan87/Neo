export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          Neo Security Agent API
        </h1>
        <p className="mt-4">
          Claude-powered SOC analyst agent. POST to{" "}
          <code>/api/agent</code> to begin.
        </p>
      </div>
    </main>
  );
}
