import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { authRoutes } from "../src/routes/auth.js";

test("auth responses keep Cognito tokens and sessions out of logs and errors", async () => {
  const responses = [
    { AuthenticationResult: { IdToken: "test-id-token", RefreshToken: "test-refresh-token", ExpiresIn: 3600 } },
    { Session: "private-login-session" },
    { Session: "private-mfa-session" },
  ];
  const logs = [];
  const originalSend = CognitoIdentityProviderClient.prototype.send;
  const originalLog = console.log;
  CognitoIdentityProviderClient.prototype.send = async () => responses.shift();
  console.log = (...args) => logs.push(args.join(" "));

  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    const login = await post("/auth/login", { username: "user", password: "password" });
    assert.equal(login.body.token, "test-id-token");
    assert.ok(!logs.join(" ").includes("test-id-token"));
    assert.ok(!logs.join(" ").includes("test-refresh-token"));

    const unexpected = await post("/auth/login", { username: "user", password: "password" });
    assert.equal(unexpected.status, 400);
    assert.deepEqual(unexpected.body, { error: "Unexpected login response" });

    const mfa = await post("/auth/verify-mfa", { username: "user", code: "123456", session: "test-session" });
    assert.equal(mfa.status, 400);
    assert.deepEqual(mfa.body, { error: "No token returned" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    CognitoIdentityProviderClient.prototype.send = originalSend;
    console.log = originalLog;
  }
});
