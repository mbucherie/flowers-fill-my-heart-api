const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const pool = require("../db/connection");

const { sendEmail } = require("../utils/email");

const router = express.Router();



function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

router.post("/create", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { email, userId, password } = req.body;

    if (!email || !userId || !password) {
      connection.release();

      return res.status(400).json({
        error: "Email, User ID, and password are required."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUserId = userId.trim();

    if (!normalizedEmail || !normalizedUserId || password.length < 8) {
      connection.release();

      return res.status(400).json({
        error:
          "Please provide valid account information. Password must be at least 8 characters."
      });
    }

    await connection.beginTransaction();

    const [existingUsers] = await connection.query(
      `SELECT id, email, user_id
       FROM users
       WHERE email = ? OR user_id = ?
       LIMIT 1`,
      [normalizedEmail, normalizedUserId]
    );

    if (existingUsers.length > 0) {
      await connection.rollback();
      connection.release();

      if (existingUsers[0].email === normalizedEmail) {
        return res.status(409).json({
          error: "An account with that email already exists."
        });
      }

      if (existingUsers[0].user_id === normalizedUserId) {
        return res.status(409).json({
          error: "That User ID is already in use."
        });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await connection.query(
      `INSERT INTO users
        (email, user_id, password_hash)
       VALUES (?, ?, ?)`,
      [
        normalizedEmail,
        normalizedUserId,
        passwordHash
      ]
    );

    const newUserId = result.insertId;

    const confirmationToken = crypto.randomBytes(32).toString("hex");

    const confirmationTokenHash = crypto
      .createHash("sha256")
      .update(confirmationToken)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + 1000 * 60 * 60
    );

    await connection.query(
      `INSERT INTO account_confirmation_tokens
        (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [
        newUserId,
        confirmationTokenHash,
        expiresAt
      ]
    );

    const confirmationUrl =
      `https://flowersfillmyheart.com/confirm-account?token=${encodeURIComponent(
        confirmationToken
      )}`;

    console.log("CONFIRMATION EMAIL:", {
      userId: newUserId,
      email: normalizedEmail,
      tokenLength: confirmationToken.length,
      tokenHash: confirmationTokenHash
    });

    await sendEmail({
      to: normalizedEmail,
      subject: "Confirm your Flowers Fill My Heart account",
      text:
        `You have successfully created an account at flowersfillmyheart.com.\n\n` +
        `Please click the link below to continue your subscription purchase.\n\n` +
        `This link expires in 1 hour.\n\n` +
        `${confirmationUrl}`,
      html:
        `<p>You have successfully created an account at flowersfillmyheart.com.</p>` +
        `<p>Please click the link below to continue your subscription purchase.</p>` +
        `<p>This link expires in 1 hour.</p>` +
        `<p><a href="${confirmationUrl}">Confirm My Account</a></p>`
    });

    console.log("CONFIRMATION EMAIL SENT:", normalizedEmail);

    await connection.commit();
    connection.release();

    return res.status(201).json({
      message: "Account created successfully.",
      userId: normalizedUserId
    });

  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error(
        "ACCOUNT CREATION ROLLBACK ERROR:",
        rollbackError
      );
    }

    connection.release();

    if (error.code === "ER_DUP_ENTRY") {
      if (error.message.includes("unique_email")) {
        return res.status(409).json({
          error: "An account with that email already exists."
        });
      }

      if (error.message.includes("unique_user_id")) {
        return res.status(409).json({
          error: "That User ID is already in use."
        });
      }

      return res.status(409).json({
        error: "That account information is already in use."
      });
    }

    console.error("ACCOUNT CREATION ERROR:", error);

    return res.status(500).json({
      error: "Unable to create account."
    });
  }
});

router.get("/confirm-account", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { token } = req.query;

    if (!token) {
      connection.release();

      return res.status(400).json({
        error: "Confirmation token is required."
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT id, user_id, expires_at, confirmed_at
       FROM account_confirmation_tokens
       WHERE token_hash = ?
       LIMIT 1
       FOR UPDATE`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await connection.rollback();
      connection.release();

      return res.status(400).json({
        error: "Invalid confirmation link."
      });
    }

    const confirmationToken = rows[0];

    if (confirmationToken.confirmed_at) {
      await connection.rollback();
      connection.release();

      return res.status(400).json({
        error: "This account has already been confirmed."
      });
    }

    if (new Date(confirmationToken.expires_at) <= new Date()) {
      await connection.rollback();
      connection.release();

      return res.status(400).json({
        error: "This confirmation link has expired.",
        code: "CONFIRMATION_TOKEN_EXPIRED"
     });
    }

    await connection.query(
      `UPDATE users
       SET email_confirmed_at = NOW()
       WHERE id = ?`,
      [confirmationToken.user_id]
    );

    await connection.query(
      `UPDATE account_confirmation_tokens
       SET confirmed_at = NOW()
       WHERE id = ?`,
      [confirmationToken.id]
    );

    await connection.commit();
    connection.release();

    return res.status(200).json({
      message: "Account confirmed successfully."
    });

  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error("ACCOUNT CONFIRMATION ROLLBACK ERROR:", rollbackError);
    }

    connection.release();

    console.error("ACCOUNT CONFIRMATION ERROR:", error);

    return res.status(500).json({
      error: "Unable to confirm account."
    });
  }
});

router.post("/request-confirmation", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { token } = req.body;

    if (!token) {
      connection.release();

      return res.status(200).json({
        message:
          "If your confirmation link can be replaced, a new confirmation link has been sent."
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT
        act.id,
        act.user_id,
        u.email,
        u.email_confirmed_at
       FROM account_confirmation_tokens act
       INNER JOIN users u ON u.id = act.user_id
       WHERE act.token_hash = ?
       LIMIT 1
       FOR UPDATE`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await connection.rollback();
      connection.release();

      return res.status(200).json({
        message:
          "If your confirmation link can be replaced, a new confirmation link has been sent."
      });
    }

    const confirmationToken = rows[0];

    if (confirmationToken.email_confirmed_at) {
      await connection.rollback();
      connection.release();

      return res.status(200).json({
        message:
          "If your confirmation link can be replaced, a new confirmation link has been sent."
      });
    }

    const newConfirmationToken = crypto.randomBytes(32).toString("hex");

    const newConfirmationTokenHash = crypto
      .createHash("sha256")
      .update(newConfirmationToken)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + 1000 * 60 * 60
    );

    await connection.query(
      `DELETE FROM account_confirmation_tokens
       WHERE id = ?`,
      [confirmationToken.id]
    );

    await connection.query(
      `INSERT INTO account_confirmation_tokens
        (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [
        confirmationToken.user_id,
        newConfirmationTokenHash,
        expiresAt
      ]
    );

    const confirmationUrl =
      `https://flowersfillmyheart.com/confirm-account?token=${encodeURIComponent(
        newConfirmationToken
      )}`;

    console.log("NEW CONFIRMATION EMAIL:", {
      userId: confirmationToken.user_id,
      email: confirmationToken.email,
      tokenLength: newConfirmationToken.length,
      tokenHash: newConfirmationTokenHash
    });

    await sendEmail({
      to: confirmationToken.email,
      subject: "Confirm your Flowers Fill My Heart account",
      text:
        `You have successfully created an account at flowersfillmyheart.com.\n\n` +
        `Please click the link below to continue your subscription purchase.\n\n` +
        `This link expires in 1 hour.\n\n` +
        `${confirmationUrl}`,
      html:
        `<p>You have successfully created an account at flowersfillmyheart.com.</p>` +
        `<p>Please click the link below to continue your subscription purchase.</p>` +
        `<p>This link expires in 1 hour.</p>` +
        `<p><a href="${confirmationUrl}">Confirm My Account</a></p>`
    });

    console.log(
      "NEW CONFIRMATION EMAIL SENT:",
      confirmationToken.email
    );

    await connection.commit();
    connection.release();

    return res.status(200).json({
      message:
        "If your confirmation link can be replaced, a new confirmation link has been sent."
    });

  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error(
        "REQUEST CONFIRMATION ROLLBACK ERROR:",
        rollbackError
      );
    }

    connection.release();

    console.error("REQUEST CONFIRMATION ERROR:", error);

    return res.status(500).json({
      error: "Unable to request a new confirmation link."
    });
  }
});


router.post("/login", async (req, res) => {
  try {
    const { userId, password } = req.body;

    if (!userId || !password) {
      return res.status(400).json({
        error: "User ID and password are required."
      });
    }

    const normalizedUserId = userId.trim();

    const [users] = await pool.query(
      `SELECT
        id,
        account_number,
        email,
        user_id,
        password_hash,
        has_subscription,
        subscription_provider,
        subscription_id,
        subscription_plan,
        subscription_status,
        subscription_start_date,
        subscription_end_date,
        subscription_cancelled_date
       FROM users
       WHERE user_id = ?
       LIMIT 1`,
      [normalizedUserId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        error: "Invalid User ID or password."
      });
    }

    const user = users[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        error: "Invalid User ID or password."
      });
    }

    const sessionToken = generateSessionToken();
    const tokenHash = hashSessionToken(sessionToken);

    const expiresAt = new Date(
      Date.now() + 1000 * 60 * 60 * 24 * 30
    );

    await pool.query(
      `INSERT INTO sessions
        (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [
        user.id,
        tokenHash,
        expiresAt
      ]
    );

    return res.status(200).json({
      message: "Login successful.",
      token: sessionToken,
      user: {
        accountNumber: user.account_number,
        email: user.email,
        userId: user.user_id,
        hasSubscription: user.has_subscription,
        subscriptionProvider: user.subscription_provider,
        subscriptionId: user.subscription_id,
        subscriptionPlan: user.subscription_plan,
        subscriptionStatus: user.subscription_status,
        subscriptionStartDate: user.subscription_start_date,
        subscriptionEndDate: user.subscription_end_date,
        subscriptionCancelledDate:
          user.subscription_cancelled_date
      }
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(500).json({
      error: "Unable to log in."
  
   });

  }

  });

  router.post("/logout", async (req, res) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res.status(200).json({
        message: "Logout successful."
      });
    }

    const sessionToken = authorization.slice(7).trim();

    if (!sessionToken) {
      return res.status(200).json({
        message: "Logout successful."
      });
    }

    const tokenHash = hashSessionToken(sessionToken);

    await pool.query(
      `DELETE FROM sessions
       WHERE token_hash = ?`,
      [tokenHash]
    );

    return res.status(200).json({
      message: "Logout successful."
    });

  } catch (error) {
    console.error("LOGOUT ERROR:", error);

    return res.status(500).json({
      error: "Unable to log out."
    });
  }
});

module.exports = router;