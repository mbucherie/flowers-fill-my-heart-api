const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const pool = require("../db/connection");

const router = express.Router();

function generateAccountNumber() {
  return "FMH" + crypto.randomInt(10000000, 100000000);
}

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
  try {
    const { email, userId, password } = req.body;

    if (!email || !userId || !password) {
      return res.status(400).json({
        error: "Email, User ID, and password are required."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUserId = userId.trim();

    if (!normalizedEmail || !normalizedUserId || password.length < 8) {
      return res.status(400).json({
        error: "Please provide valid account information. Password must be at least 8 characters."
      });
    }

    const [existingUsers] = await pool.query(
      "SELECT id, email, user_id FROM users WHERE email = ? OR user_id = ? LIMIT 1",
      [normalizedEmail, normalizedUserId]
    );

    if (existingUsers.length > 0) {
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

    let accountNumber;
    let accountNumberExists = true;

    while (accountNumberExists) {
      accountNumber = generateAccountNumber();

      const [existingAccount] = await pool.query(
        "SELECT id FROM users WHERE account_number = ? LIMIT 1",
        [accountNumber]
      );

      accountNumberExists = existingAccount.length > 0;
    }

    await pool.query(
      `INSERT INTO users
        (account_number, email, user_id, password_hash)
       VALUES (?, ?, ?, ?)`,
      [
        accountNumber,
        normalizedEmail,
        normalizedUserId,
        passwordHash
      ]
    );

    return res.status(201).json({
      message: "Account created successfully.",
      accountNumber,
      userId: normalizedUserId
    });

  } catch (error) {
    console.error("ACCOUNT CREATION ERROR:", error);

    return res.status(500).json({
      error: "Unable to create account."
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
      `SELECT id, account_number, email, user_id, password_hash
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
        userId: user.user_id
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(500).json({
      error: "Unable to log in."
    });
  }
});

module.exports = router;
