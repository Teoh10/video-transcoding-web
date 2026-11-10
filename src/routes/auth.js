import { Router } from "express";
import crypto from "crypto";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  AuthFlowType,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION,
});

// Helper: build secret hash if client has a secret
function secretHash(username) {
  if (!process.env.COGNITO_CLIENT_SECRET) return undefined;
  const hasher = crypto.createHmac("sha256", process.env.COGNITO_CLIENT_SECRET);
  hasher.update(`${username}${process.env.COGNITO_CLIENT_ID}`);
  return hasher.digest("base64");
}

export function authRoutes() {
  const router = Router();

  // ---------------- Register user ----------------
  router.post("/register", async (req, res) => {
    const { username, password, email } = req.body;
    if (!username || !password || !email) {
      return res.status(400).json({ error: "username, password, email required" });
    }

    try {
      await client.send(
        new SignUpCommand({
          ClientId: process.env.COGNITO_CLIENT_ID,
          Username: username,
          Password: password,
          SecretHash: secretHash(username),
          UserAttributes: [{ Name: "email", Value: email }],
        })
      );
      res.json({ message: "Check email for confirmation code" });
    } catch (err) {
      console.error("❌ Cognito signup failed:", err);
      res.status(400).json({ error: err.message || "Signup failed" });
    }
  });

  // ---------------- Confirm email ----------------
  router.post("/confirm", async (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) {
      return res.status(400).json({ error: "username and code required" });
    }

    try {
      await client.send(
        new ConfirmSignUpCommand({
          ClientId: process.env.COGNITO_CLIENT_ID,
          Username: username,
          ConfirmationCode: code,
          SecretHash: secretHash(username),
        })
      );
      res.json({ message: "Account confirmed" });
    } catch (err) {
      console.error("❌ Cognito confirm failed:", err);
      res.status(400).json({ error: err.message || "Confirm failed" });
    }
  });

  // ---------------- Login (step 1) ----------------
  router.post("/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    try {
      const result = await client.send(
        new InitiateAuthCommand({
          AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
          ClientId: process.env.COGNITO_CLIENT_ID,
          AuthParameters: {
            USERNAME: username,
            PASSWORD: password,
            ...(process.env.COGNITO_CLIENT_SECRET
              ? { SECRET_HASH: secretHash(username) }
              : {}),
          },
        })
      );

      // MFA Setup required (first-time setup)
      if (result.ChallengeName === "MFA_SETUP") {
        return res.json({
          setupRequired: true,
          session: result.Session,
        });
      }

      // MFA required (already configured)
      if (result.ChallengeName === "SOFTWARE_TOKEN_MFA" || result.ChallengeName === "SMS_MFA") {
        return res.json({
          mfaRequired: true,
          challengeName: result.ChallengeName,
          session: result.Session,
        });
      }

      // Normal login (no MFA)
      if (result.AuthenticationResult?.IdToken) {
        return res.json({
          token: result.AuthenticationResult.IdToken,
          refreshToken: result.AuthenticationResult.RefreshToken,
          expiresIn: result.AuthenticationResult.ExpiresIn,
        });
      }

      res.status(400).json({ error: "Unexpected login response" });
    } catch (err) {
      console.error("❌ Cognito login failed:", err);
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // ---------------- MFA Setup (generate secret) ----------------
  router.post("/setup-mfa", async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: "session required" });

    try {
      const result = await client.send(
        new AssociateSoftwareTokenCommand({ Session: session })
      );

      res.json({
        secretCode: result.SecretCode, // to generate QR Code
        session: result.Session,
      });
    } catch (err) {
      console.error("❌ MFA setup failed:", err);
      res.status(400).json({ error: "MFA setup failed" });
    }
  });

  // ---------------- Verify MFA setup ----------------
  router.post("/verify-setup", async (req, res) => {
    const { session, code } = req.body;
    if (!session || !code) return res.status(400).json({ error: "session and code required" });

    try {
      const result = await client.send(
        new VerifySoftwareTokenCommand({
          Session: session,
          UserCode: code,
          FriendlyDeviceName: "AuthenticatorApp",
        })
      );

      if (result.Status === "SUCCESS") {
        res.json({ message: "MFA setup complete" });
      } else {
        res.status(400).json({ error: "MFA setup failed" });
      }
    } catch (err) {
      console.error("❌ Verify setup failed:", err);
      res.status(400).json({ error: "Verify setup failed" });
    }
  });

  // ---------------- Verify MFA login (step 2) ----------------
  router.post("/verify-mfa", async (req, res) => {
    const { username, code, session } = req.body;
    if (!username || !code || !session) {
      return res.status(400).json({ error: "username, code, and session required" });
    }

    try {
      const result = await client.send(
        new RespondToAuthChallengeCommand({
          ClientId: process.env.COGNITO_CLIENT_ID,
          ChallengeName: "SOFTWARE_TOKEN_MFA", // or SMS_MFA
          Session: session,
          ChallengeResponses: {
            USERNAME: username,
            SOFTWARE_TOKEN_MFA_CODE: code,
            ...(process.env.COGNITO_CLIENT_SECRET
              ? { SECRET_HASH: secretHash(username) }
              : {}),
          },
        })
      );

      const token = result.AuthenticationResult?.IdToken;
      if (!token) {
        return res.status(400).json({ error: "No token returned" });
      }

      res.json({
        token,
        refreshToken: result.AuthenticationResult.RefreshToken,
        expiresIn: result.AuthenticationResult.ExpiresIn,
      });
    } catch (err) {
      console.error("❌ MFA verification failed:", err);
      res.status(401).json({ error: "MFA verification failed" });
    }
  });

  // ---------------- Refresh token ----------------
  router.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "refreshToken required" });

    try {
      const result = await client.send(
        new InitiateAuthCommand({
          AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
          ClientId: process.env.COGNITO_CLIENT_ID,
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        })
      );

      if (!result.AuthenticationResult?.IdToken) {
        return res.status(400).json({ error: "No new token" });
      }

      res.json({
        token: result.AuthenticationResult.IdToken,
        expiresIn: result.AuthenticationResult.ExpiresIn,
      });
    } catch (err) {
      console.error("❌ Refresh failed:", err);
      res.status(401).json({ error: "Refresh failed" });
    }
  });

  return router;
}
