const crypto = require("crypto");
const pool = require("../db/connection");

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    const tokenHash = hashSessionToken(token);

    const [rows] = await pool.query(
      `SELECT
         sessions.id AS session_id,
         sessions.user_id,
         sessions.expires_at,
         users.account_number,
         users.email,
         users.user_id AS user_identifier
       FROM sessions
       INNER JOIN users
         ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?
         AND sessions.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: "Invalid or expired session."
      });
    }

    req.user = {
      id: rows[0].user_id,
      accountNumber: rows[0].account_number,
      email: rows[0].email,
      userId: rows[0].user_identifier,
      sessionId: rows[0].session_id
    };

    next();

  } catch (error) {
    console.error("AUTHENTICATION ERROR:", error);

    return res.status(500).json({
      error: "Unable to authenticate request."
    });
  }
}

module.exports = requireAuth;
