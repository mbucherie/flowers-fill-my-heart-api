const express = require("express");
const pool = require("../db/connection");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  try {
    const {
      designName,
      heartSize,
      designData
    } = req.body;

    if (!designName || !heartSize || !designData) {
      return res.status(400).json({
        error: "Design name, heart size, and design data are required."
      });
    }

    const normalizedName = String(designName).trim();
    const normalizedHeartSize = String(heartSize).trim();

    if (!normalizedName || !normalizedHeartSize) {
      return res.status(400).json({
        error: "Design name and heart size are required."
      });
    }

    if (normalizedName.length > 100) {
      return res.status(400).json({
        error: "Design name must be 100 characters or fewer."
      });
    }

    await pool.query(
      `INSERT INTO saved_designs
        (user_id, design_name, heart_size, design_data)
       VALUES (?, ?, ?, ?)`,
      [
        req.user.id,
        normalizedName,
        normalizedHeartSize,
        JSON.stringify(designData)
      ]
    );

    return res.status(201).json({
      message: "Design saved successfully."
    });

  } catch (error) {
    console.error("SAVE DESIGN ERROR:", error);

    return res.status(500).json({
      error: "Unable to save design."
    });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         id,
         design_name,
         heart_size,
         design_data,
         created_at,
         updated_at
       FROM saved_designs
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
      [req.user.id]
    );

    const designs = rows.map((design) => ({
      id: design.id,
      designName: design.design_name,
      heartSize: design.heart_size,
      designData:
        typeof design.design_data === "string"
          ? JSON.parse(design.design_data)
          : design.design_data,
      createdAt: design.created_at,
      updatedAt: design.updated_at
    }));

    return res.status(200).json({
      designs
    });

  } catch (error) {
    console.error("LOAD DESIGNS ERROR:", error);

    return res.status(500).json({
      error: "Unable to load saved designs."
    });
  }
});

module.exports = router;
