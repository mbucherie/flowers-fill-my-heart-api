const express = require("express");
const cors = require("cors");
require("dotenv").config();

const accountRoutes = require("./routes/accounts");
const authTestRoutes = require("./routes/auth-test");
const designRoutes = require("./routes/designs");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Flowers Fill My Heart API"
  });
});

app.use("/api/accounts", accountRoutes);

app.use("/api", authTestRoutes);

app.use("/api/designs", designRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Flowers Fill My Heart API running on port ${PORT}`);
});
