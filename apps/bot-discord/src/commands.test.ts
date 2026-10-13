import { describe, expect, test } from "bun:test";
import { getCommandData } from "./commands.ts";

describe("slash command data", () => {
  test("edit and append commands expose id/content inputs", () => {
    const commands = getCommandData() as Array<{
      name: string;
      options?: Array<{ name: string; required?: boolean }>;
    }>;

    const edit = commands.find((cmd) => cmd.name === "edit");
    const append = commands.find((cmd) => cmd.name === "append");

    expect(edit?.options?.map((opt) => opt.name)).toEqual(["id", "content", "reason"]);
    expect(edit?.options?.find((opt) => opt.name === "id")?.required).toBe(true);
    expect(edit?.options?.find((opt) => opt.name === "content")?.required).toBe(true);
    expect(append?.options?.map((opt) => opt.name)).toEqual(["id", "content"]);
    expect(append?.options?.every((opt) => opt.required === true)).toBe(true);
  });
});
