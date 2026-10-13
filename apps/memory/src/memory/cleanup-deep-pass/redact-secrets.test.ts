import { expect, test } from "bun:test";
import { REDACTED_MARK, redactSecrets } from "./redact-secrets.ts";

test("provider keys, bearer tokens and api-key headers are masked; status and code stay", () => {
  const out = redactSecrets(
    "status=401 code=invalid_api_key: Incorrect API key provided: sk-proj-abc...wxyz. Authorization: Bearer abc.def.ghi x-api-key: sk-ant-xxxx",
  );
  for (const secret of ["sk-proj-abc", "wxyz", "abc.def.ghi", "sk-ant-xxxx"]) expect(out).not.toContain(secret);
  expect(out).toContain("status=401");
  expect(out).toContain("code=invalid_api_key");
  expect(out).toContain(`x-api-key: ${REDACTED_MARK}`);
});

test("a long token-like string is masked; ordinary words and short values are kept", () => {
  const token = "a".repeat(20) + "B9_-".repeat(5);
  const out = redactSecrets(`entityRegister 단계에서 중단: token ${token} 응답 없음 (timeout 900000ms)`);
  expect(out).not.toContain(token);
  expect(out).toContain("entityRegister 단계에서 중단");
  expect(out).toContain("900000ms");
});

test("Authorization: Basic keeps the scheme word and masks the credential", () => {
  const out = redactSecrets("proxy said 401: Authorization: Basic dXNlcjpodW50ZXIy rejected");
  expect(out).not.toContain("dXNlcjpodW50ZXIy");
  expect(out).toContain(`Authorization: Basic ${REDACTED_MARK}`);
  expect(out).toContain("rejected");
});

test("short password/token/secret field values are masked in JSON and k=v forms", () => {
  const out = redactSecrets(
    `body={"password":"hunter2","passwd": "pw1", "secret":"s3"} password=hunter3 token: abc123 apikey=k1 access_token=t1 api_key: k2`,
  );
  for (const secret of ["hunter2", "pw1", "s3\"", "hunter3", "abc123", "k1", "t1", "k2"]) expect(out).not.toContain(secret);
  expect(out).toContain(`"password":"${REDACTED_MARK}"`);
  expect(out).toContain(`password=${REDACTED_MARK}`);
  expect(out).toContain(`token: ${REDACTED_MARK}`);
});

test("UUIDs, status codes and stage names stay readable", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const out = redactSecrets(`run ${uuid} entityRegister 단계 status=503 code=overloaded max_tokens=4096`);
  expect(out).toBe(`run ${uuid} entityRegister 단계 status=503 code=overloaded max_tokens=4096`);
});

test("the field pattern stays fast on long adversarial input (no catastrophic backtracking)", () => {
  const evil = `token${" ".repeat(50_000)}"${" ".repeat(50_000)}x`;
  const started = performance.now();
  redactSecrets(evil);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("prefixed secret field names (client_secret, refresh_token, db_password) mask short values in plain, k=v and JSON forms", () => {
  const cases: Array<[string, string, string]> = [
    ["client_secret=abc123", "abc123", `client_secret=${REDACTED_MARK}`],
    ["refresh_token=t1", "t1", `refresh_token=${REDACTED_MARK}`],
    ["db_password: pw", "pw", `db_password: ${REDACTED_MARK}`],
    ['{"client_secret":"abc123"}', "abc123", `"client_secret":"${REDACTED_MARK}"`],
    ['{"refresh_token": "t1"}', "t1", `"refresh_token": "${REDACTED_MARK}"`],
    ['{"db_password":"pw"}', "pw", `"db_password":"${REDACTED_MARK}"`],
    ["CLIENT_SECRET=abc", "abc", `CLIENT_SECRET=${REDACTED_MARK}`],
    ["x-auth-token: zz9", "zz9", `x-auth-token: ${REDACTED_MARK}`],
    ["a=1 client_secret=abc123 b=2", "abc123", `client_secret=${REDACTED_MARK}`],
  ];
  for (const [input, secret, expected] of cases) {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(expected);
  }
});

test("ordinary words that merely contain a secret word are not masked", () => {
  for (const text of ["token budget exceeded", "passwordless login", "secretary said hi", "max_tokens=4096"]) {
    expect(redactSecrets(text)).toBe(text);
  }
});

test("secret names with a suffix or in camelCase mask short values (secret_key, aws_secret_access_key, private_key, authToken, accessToken, apiKey, clientSecret)", () => {
  const cases: Array<[string, string]> = [
    ["secret_key=sk1", "secret_key"],
    ["secret-key: sk2", "secret-key"],
    ["aws_secret_access_key=ak3", "aws_secret_access_key"],
    ["secret_access_key=ak4", "secret_access_key"],
    ["private_key=pk5", "private_key"],
    ["private-key: pk6", "private-key"],
    ['{"authToken":"at7"}', "authToken"],
    ['{"accessToken": "ac8"}', "accessToken"],
    ['{"apiKey":"ap9"}', "apiKey"],
    ['{"clientSecret":"cs0"}', "clientSecret"],
    ["AUTHTOKEN=at1", "AUTHTOKEN"],
  ];
  for (const [input, name] of cases) {
    const out = redactSecrets(input);
    expect(out).toContain(name);
    expect(out).toContain(REDACTED_MARK);
    expect(out).not.toMatch(/(sk1|sk2|ak3|ak4|pk5|pk6|at7|ac8|ap9|cs0|at1)/);
  }
});

test("ordinary words stay unmasked after the suffix names were added", () => {
  for (const text of ["token budget exceeded", "passwordless login", "secretary said hi", "max_tokens=4096", "input_tokens: 120", "usage {input_tokens: 120, output_tokens: 20}"]) {
    expect(redactSecrets(text)).toBe(text);
  }
});
