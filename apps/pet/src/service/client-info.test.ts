import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { clientInfoFailure, interpretClientInfo } from "./client-info.ts";
import { ServiceError } from "./errors.ts";
import { publicError } from "./protocol.ts";

/** The answer a Pet-integrated core sends (apps/setup/PET-INTEGRATION.md "클라이언트 API"). */
const CURRENT = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, version: "0.9.0",
  captureKinds: ["idea", "decision", "question", "preference", "task"],
  capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"] });

test("a current core's answer is ready and keeps what the Pet relies on", () => {
  expect(interpretClientInfo(200, CURRENT)).toEqual({ kind: "ready", info: { protocolVersion: PROTOCOL_VERSION, version: "0.9.0",
    captureKinds: ["idea", "decision", "question", "preference", "task"],
    capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"] } });
});

test("optional fields are read only when well formed and non-string entries are dropped", () => {
  const body = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, version: 7, capabilities: ["capture", 3, null, "memory-deeplink"] });
  expect(interpretClientInfo(200, body)).toEqual({ kind: "ready",
    info: { protocolVersion: PROTOCOL_VERSION, capabilities: ["capture", "memory-deeplink"] } });
});

test("a status that proves the cause fails at once, whatever the body says", () => {
  for (const [status, code] of [[401, "AUTH_REJECTED"], [403, "SERVER_UPGRADE_REQUIRED"], [404, "SERVER_UPGRADE_REQUIRED"]] as const)
    expect(interpretClientInfo(status, CURRENT)).toEqual({ kind: "failed", code, status });
});

test("a server error is worth asking again", () => {
  for (const status of [500, 502, 503, 599]) expect(interpretClientInfo(status, "")).toEqual({ kind: "retry", status });
});

test("an answer outside the protocol is incompatible, not a reason to keep waiting", () => {
  const bodies = ["<!doctype html><title>dashboard</title>", "", "null", "[]", "{}", JSON.stringify({ capabilities: [] }),
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION + 1, capabilities: [] }),
    JSON.stringify({ protocolVersion: String(PROTOCOL_VERSION), capabilities: [] }),
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION }), JSON.stringify({ protocolVersion: PROTOCOL_VERSION, capabilities: {} })];
  for (const body of bodies)
    expect(interpretClientInfo(200, body)).toEqual({ kind: "failed", code: "SERVER_INCOMPATIBLE", status: 200 });
  expect(interpretClientInfo(204, "")).toEqual({ kind: "failed", code: "SERVER_INCOMPATIBLE", status: 204 });
  for (const status of [302, 400, 405, 410, 429])
    expect(interpretClientInfo(status, CURRENT)).toEqual({ kind: "failed", code: "SERVER_INCOMPATIBLE", status });
});

test("each failure becomes a service error with its code and the messages.ts text", () => {
  const rejected = clientInfoFailure({ code: "AUTH_REJECTED", status: 401 });
  expect(rejected).toBeInstanceOf(ServiceError);
  expect(rejected).toMatchObject({ code: "AUTH_REJECTED", publicMessage: messages.connectionErrors.AUTH_REJECTED });
  expect(clientInfoFailure({ code: "SERVER_UPGRADE_REQUIRED", status: 404 }))
    .toMatchObject({ code: "SERVER_UPGRADE_REQUIRED", publicMessage: messages.connectionErrors.SERVER_UPGRADE_REQUIRED });
  const incompatible = clientInfoFailure({ code: "SERVER_INCOMPATIBLE", status: 302 });
  expect(incompatible).toMatchObject({ code: "SERVER_INCOMPATIBLE", publicMessage: messages.connectionErrors.SERVER_INCOMPATIBLE(302) });
  expect(incompatible.publicMessage).toContain("302");
});

test("the texts reach the screen as they are instead of the generic internal error", () => {
  for (const [code, status] of [["AUTH_REJECTED", 401], ["SERVER_UPGRADE_REQUIRED", 403], ["SERVER_INCOMPATIBLE", 200]] as const) {
    const error = clientInfoFailure({ code, status });
    expect(publicError(error)).toEqual({ code, message: error.publicMessage });
  }
});
