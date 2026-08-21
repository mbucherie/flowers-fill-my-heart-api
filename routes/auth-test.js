const express = require("express");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.get("/test-auth", requireAuth, (req, res) => {
  res.json({
    message: "Authentication successful.",
    user: req.user
  });
});

module.exports = router;
