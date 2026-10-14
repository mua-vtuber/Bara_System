import { afterEach, expect, test } from "bun:test";
import type { ReleaseSource } from "../../shared/self-update.ts";
import { selfUpdateHeaders } from "../../shared/self-update.ts";
import { fetchLatestRelease } from "./check.ts";

// Every case runs against a real loopback listener or a real closed port; nothing is replaced by a fake.
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const never = () => new AbortController().signal;

function releaseServer(answer: (request: Request, source: ReleaseSource) => Response | Promise<Response>) {
  // Bun empties a Request's headers once the handler returns, so the parts the tests read are copied inside it.
  const seen: Array<{ method: string; headers: Headers }> = [];
  let source!: ReleaseSource;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { seen.push({ method: request.method, headers: new Headers(request.headers) }); return answer(request, source); } });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  source = { latestUrl: `${origin}/repos/mua-vtuber/Bara_System/releases/latest`, downloadBaseUrl: `${origin}/download/` };
  return { source, seen };
}
function releaseBody(source: ReleaseSource, tag = "v0.1.9") {
  const name = `Bara.Pet_${tag.slice(1)}_x64-setup.exe`;
  return { tag_name: tag, assets: [{ name, size: 1234, digest: `sha256:${"a".repeat(64)}`, browser_download_url: `${source.downloadBaseUrl}${tag}/${name}` }] };
}

test("a newer release is available, the same release is current", async () => {
  const { source } = releaseServer((_request, own) => Response.json(releaseBody(own)));
  const outcome = await fetchLatestRelease(source, "0.1.8", never());
  expect(outcome.kind).toBe("available");
  expect(outcome.kind === "available" && outcome.release.version).toBe("0.1.9");
  expect(await fetchLatestRelease(source, "0.1.9", never())).toEqual({ kind: "current", latest: "0.1.9" });
});

test("the request carries only Accept and the pet's User-Agent, never a credential", async () => {
  const { source, seen } = releaseServer((_request, own) => Response.json(releaseBody(own)));
  await fetchLatestRelease(source, "0.1.8", never());
  const headers = seen[0]!.headers;
  expect(seen[0]!.method).toBe("GET");
  expect(headers.get("accept")).toBe(selfUpdateHeaders().Accept!);
  expect(headers.get("user-agent")).toBe(selfUpdateHeaders()["User-Agent"]!);
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("cookie")).toBeNull();
});

test("GitHub's rate limit is a 403: the check fails with the status, not as 'no update'", async () => {
  const { source } = releaseServer(() => Response.json({ message: "API rate limit exceeded" }, { status: 403 }));
  const outcome = await fetchLatestRelease(source, "0.1.8", never());
  expect(outcome).toMatchObject({ kind: "failed", code: "SELF_UPDATE_HTTP" });
  expect(outcome.kind === "failed" && outcome.message).toContain("403");
});

test("an answer that is not JSON fails as an unreadable response", async () => {
  const { source } = releaseServer(() => new Response("<html>", { headers: { "content-type": "application/json" } }));
  expect(await fetchLatestRelease(source, "0.1.8", never())).toMatchObject({ kind: "failed", code: "SELF_UPDATE_RESPONSE_INVALID" });
});

test("a release with the wrong shape fails with the parser's code", async () => {
  const { source } = releaseServer((_request, own) => Response.json({ ...releaseBody(own), tag_name: "0.1.9" }));
  expect(await fetchLatestRelease(source, "0.1.8", never())).toMatchObject({ kind: "failed", code: "SELF_UPDATE_TAG_INVALID" });
});

test("a closed port fails as a network failure with a cause", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const origin = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  const outcome = await fetchLatestRelease({ latestUrl: `${origin}/latest`, downloadBaseUrl: `${origin}/download/` }, "0.1.8", never());
  expect(outcome).toMatchObject({ kind: "failed", code: "SELF_UPDATE_NETWORK" });
  expect(outcome.kind === "failed" && outcome.message).toContain("원인:");
});

test("a server that never answers fails as a timeout", async () => {
  const { source } = releaseServer(() => new Promise<Response>(() => {}));
  expect(await fetchLatestRelease(source, "0.1.8", never(), 200)).toMatchObject({ kind: "failed", code: "SELF_UPDATE_TIMEOUT" });
});

test("a redirect is not followed", async () => {
  const { source } = releaseServer((_request, own) => Response.redirect(`${own.downloadBaseUrl}moved`, 301));
  expect(await fetchLatestRelease(source, "0.1.8", never())).toMatchObject({ kind: "failed", code: "SELF_UPDATE_REDIRECT" });
});
