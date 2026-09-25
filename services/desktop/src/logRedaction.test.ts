import { describe, expect, it } from "vitest";
import { redactEnvArgsForLog } from "./logRedaction";

describe("redactEnvArgsForLog", () => {
  it("hides the pairing token's value and leaves every other entry as it is, in order", () => {
    expect(
      redactEnvArgsForLog([
        "KATHARA_API_LABS_DIR=/home/u/labs",
        "KATHARA_API_AUTH_TOKEN=s3cr3t-t0ken",
        "PYTHONPATH=/opt/app/site-packages",
      ]),
    ).toEqual(["KATHARA_API_LABS_DIR=/home/u/labs", "KATHARA_API_AUTH_TOKEN=***", "PYTHONPATH=/opt/app/site-packages"]);
  });

  it("hides a token whose value itself contains '='", () => {
    expect(redactEnvArgsForLog(["KATHARA_API_AUTH_TOKEN=a=b=c"])).toEqual(["KATHARA_API_AUTH_TOKEN=***"]);
  });

  it("matches the variable name exactly, not by prefix", () => {
    expect(redactEnvArgsForLog(["KATHARA_API_AUTH_TOKEN_FILE=/run/x", "X_KATHARA_API_AUTH_TOKEN=1"])).toEqual([
      "KATHARA_API_AUTH_TOKEN_FILE=/run/x",
      "X_KATHARA_API_AUTH_TOKEN=1",
    ]);
  });

  it("never lets the secret through, wherever it sits", () => {
    const logged = redactEnvArgsForLog(["A=1", "KATHARA_API_AUTH_TOKEN=s3cr3t", "B=2"]).join(" ");
    expect(logged).not.toContain("s3cr3t");
  });
});
