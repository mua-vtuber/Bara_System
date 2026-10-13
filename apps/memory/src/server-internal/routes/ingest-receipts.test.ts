import { expect, test } from "bun:test";
import { IngestReceipts } from "./ingest-receipts.ts";

test("active writes survive time/count bounds and block duplicate or changed requests", async () => {
  const receipts = new IngestReceipts(1, 10);
  const active = receipts.begin("owner", "1", { data: "first" }, 0);
  expect(active.kind).toBe("started");
  expect(receipts.get("owner", "1", 100)?.state).toBe("pending");
  expect(receipts.begin("owner", "1", { data: "first" }, 100).kind).toBe("existing");
  expect(receipts.begin("owner", "1", { data: "other" }, 100).kind).toBe("conflict");
  expect(receipts.begin("owner", "2", {}, 100).kind).toBe("full");
  if (active.kind !== "started") throw new Error("expected active receipt");
  await receipts.finish(active.receipt, Response.json({ ok: true }), 100);
  expect(receipts.begin("owner", "2", {}, 101).kind).toBe("started");
  expect(receipts.get("owner", "1", 101)).toBeUndefined();
});

test("expired and missing receipts stay absent; ambiguous or invalid server results stay unknown", async () => {
  const receipts = new IngestReceipts(3, 10);
  for (const [id, response] of [["1", undefined], ["2", new Response("invalid", { status: 201 })], ["3", Response.json({ ok: true })]] as const) {
    const started = receipts.begin("owner", id, {}, 0);
    if (started.kind !== "started") throw new Error("expected active receipt");
    await receipts.finish(started.receipt, response, 1);
    expect(receipts.get("owner", id, 2)?.state).toBe("unknown");
    expect(receipts.get("other", id, 2)).toBeUndefined();
    expect(receipts.get("owner", id, 11)).toBeUndefined();
  }
});
