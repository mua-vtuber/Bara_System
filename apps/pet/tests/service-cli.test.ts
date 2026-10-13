import { expect, test } from "bun:test";
import { cliArgs, parseCliOutput } from "../src/service/cli.ts";

test("Claude cleanup invocation has no tools or persistent session", () => {
  const args = cliArgs("claude", "", "schema.json");
  expect(args).toContain("--safe-mode");
  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--no-session-persistence");
  expect(args).not.toContain("--model");
});

test("Claude output parses only structured result envelope", () => {
  expect(parseCliOutput("claude", JSON.stringify({ type: "result", structured_output: { finding: false } }))).toEqual({ finding: false });
  expect(() => parseCliOutput("claude", '{"finding":false}')).toThrow();
});

test("Codex cleanup disables alternate code and web tool paths", () => {
  const args = cliArgs("codex", "", "schema.json");
  expect(args.slice(args.indexOf("code_mode_host") - 1, args.indexOf("code_mode_host") + 1)).toEqual(["--disable", "code_mode_host"]);
  expect(args).toContain('web_search="disabled"');
  expect(args).toContain("--ignore-user-config");
  expect(args).toContain("--ignore-rules");
});
