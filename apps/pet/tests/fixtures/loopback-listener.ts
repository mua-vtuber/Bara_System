// Test-only: a loopback HTTP listener run as its own Bun process, standing in for the local end of an
// SSH tunnel, so `CredentialRoutes.verifyTunnel` can check a real process as the port's only owner.
// Product code never imports this file.

/** Path -> JSON answer. A key ending in `*` matches every path that starts with the text before it. */
export type ListenerRoutes = Record<string, { status?: number; body: unknown }>;

export interface ListenerProcess { process: Bun.Subprocess; baseUrl: string; stop(): Promise<void> }

function answer(routes: ListenerRoutes, path: string): Response {
  const key = Object.keys(routes).find((name) => name.endsWith("*") ? path.startsWith(name.slice(0, -1)) : name === path);
  if (key === undefined) return new Response("", { status: 404 });
  const route = routes[key]!;
  return Response.json(route.body, { status: route.status ?? 200 });
}

/** Start this file as a child process serving `routes` on a free loopback port. */
export async function startListenerProcess(routes: ListenerRoutes): Promise<ListenerProcess> {
  const child = Bun.spawn([process.execPath, import.meta.path, JSON.stringify(routes)],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`listener process exited before reporting its port (exit ${await child.exited})`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const { port } = JSON.parse(text.slice(0, text.indexOf("\n"))) as { port: number };
  return { process: child, baseUrl: `http://127.0.0.1:${port}`,
    async stop() { child.kill(); await child.exited; } };
}

if (import.meta.main) {
  const routes = JSON.parse(Bun.argv[2] ?? "") as ListenerRoutes;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => answer(routes, new URL(request.url).pathname) });
  process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
}
