import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id", // IdToken includes cognito:groups
  clientId: process.env.COGNITO_CLIENT_ID,
});

export async function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = await verifier.verify(token);
    const cognitoUsername = payload["cognito:username"];
    const username = cognitoUsername || payload.username || payload.email || payload.sub;
    const userId = cognitoUsername || payload.sub || payload.email || payload.username;

    if (!userId) {
      return res.status(401).json({ error: "Token missing user identifier" });
    }

    // Attach normalized user information to request
    req.user = {
      ...payload,
      id: userId,
      username,
      groups: payload["cognito:groups"] || []
    };

    next();
  } catch (err) {
    console.error("JWT verify failed:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Middleware to check if user belongs to a specific group
export function requireGroup(group) {
  return (req, res, next) => {
    if (req.user?.groups.includes(group)) {
      return next();
    }
    return res.status(403).json({ error: `Requires ${group} group` });
  };
}
