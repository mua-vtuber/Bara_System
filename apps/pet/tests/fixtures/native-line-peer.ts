// Test-only line peer for the native bridge tests (`src-tauri/src/bridge/tests.rs`).
// It speaks the service's NDJSON line format on stdin/stdout but has only these fixed behaviors:
//   echo       -> replies with the params it got and its own process id
//   exit       -> ends the process without replying
//   grandchild -> starts a long-running child process and replies with that child's id
//   silent     -> never replies
//   heartbeat  -> sends {"event":"alive"} every params.beatMs, like the service does while it has
//                 work in progress, and replies as echo does after params.replyAfterMs
//   seen       -> replies with the ids of every request this process has read so far (in order)
//                 and its own process id, so a test can prove a line never reached this process
// Any other method gets an error reply. Product code never starts or references this file;
// real service behavior is checked by running `src/service/main.ts` itself.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

interface PeerRequest { id: string; method: string; params: Record<string, unknown> }

function send(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const seen: string[] = [];
const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line) as PeerRequest;
  seen.push(request.id);
  switch (request.method) {
    case "echo":
      send({ id: request.id, result: { params: request.params, pid: process.pid } });
      break;
    case "exit":
      process.exit(0);
    case "grandchild": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      child.unref();
      send(child.pid === undefined
        ? { id: request.id, error: { code: "PEER_SPAWN_FAILED" } }
        : { id: request.id, result: { pid: child.pid } });
      break;
    }
    case "silent":
      break;
    case "heartbeat": {
      const beatMs = positive(request.params.beatMs);
      const replyAfterMs = positive(request.params.replyAfterMs);
      if (beatMs === undefined || replyAfterMs === undefined) {
        send({ id: request.id, error: { code: "PEER_BAD_PARAMS" } });
        break;
      }
      const beat = setInterval(() => send({ event: "alive" }), beatMs);
      setTimeout(() => {
        clearInterval(beat);
        send({ id: request.id, result: { params: request.params, pid: process.pid } });
      }, replyAfterMs);
      break;
    }
    case "seen":
      send({ id: request.id, result: { ids: seen, pid: process.pid } });
      break;
    default:
      send({ id: request.id, error: { code: "PEER_UNKNOWN_METHOD" } });
  }
}
