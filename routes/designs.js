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

    // CHECK SAVED DESIGN LIMIT
   const [countRows] = await pool.query(
   `SELECT COUNT(*) AS total
   FROM saved_designs
   WHERE user_id = ?`,
   [req.user.id]
  );

  const savedDesignCount = countRows[0].total;

  const MAX_SAVED_DESIGNS = 50;

  if (savedDesignCount >= MAX_SAVED_DESIGNS) {
  return res.status(400).json({
    error:
      "You have reached your maximum of 50 saved designs. Please delete an existing design before saving a new one."
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
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const designId = Number(req.params.id);

    if (!Number.isInteger(designId) || designId <= 0) {
      return res.status(400).json({
        error: "Invalid design ID."
      });
    }

    const [rows] = await pool.query(
      `SELECT
         id,
         design_name,
         heart_size,
         design_data,
         created_at,
         updated_at
       FROM saved_designs
       WHERE id = ?
         AND user_id = ?
       LIMIT 1`,
      [
        designId,
        req.user.id
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Saved design not found."
      });
    }

    const design = rows[0];

    return res.status(200).json({
      design: {
        id: design.id,
        designName: design.design_name,
        heartSize: design.heart_size,
        designData:
          typeof design.design_data === "string"
            ? JSON.parse(design.design_data)
            : design.design_data,
        createdAt: design.created_at,
        updatedAt: design.updated_at
      }
    });

  } catch (error) {
    console.error("LOAD DESIGN ERROR:", error);

    return res.status(500).json({
      error: "Unable to load saved design."
    });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const designId = Number(req.params.id);

    if (!Number.isInteger(designId) || designId <= 0) {
      return res.status(400).json({
        error: "Invalid design ID."
      });
    }

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

    const [result] = await pool.query(
      `UPDATE saved_designs
       SET design_name = ?,
           heart_size = ?,
           design_data = ?
       WHERE id = ?
         AND user_id = ?`,
      [
        normalizedName,
        normalizedHeartSize,
        JSON.stringify(designData),
        designId,
        req.user.id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: "Saved design not found."
      });
    }

    return res.status(200).json({
      message: "Design updated successfully."
    });

  } catch (error) {
    console.error("UPDATE DESIGN ERROR:", error);

    return res.status(500).json({
      error: "Unable to update design."
    });
  }
});
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const designId = Number(req.params.id);

    if (!Number.isInteger(designId) || designId <= 0) {
      return res.status(400).json({
        error: "Invalid design ID."
      });
    }

    const [result] = await pool.query(
      `DELETE FROM saved_designs
       WHERE id = ?
         AND user_id = ?`,
      [
        designId,
        req.user.id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: "Saved design not found."
      });
    }

    return res.status(200).json({
      message: "Design deleted successfully."
    });

  } catch (error) {
    console.error("DELETE DESIGN ERROR:", error);

    return res.status(500).json({
      error: "Unable to delete design."
    });
  }
});
module.exports = router;  
