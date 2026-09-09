const express = require("express");
const cors = require("cors");
require("dotenv").config();

const accountRoutes = require("./routes/accounts");

const designRoutes = require("./routes/designs");
const paymentRoutes = require("./routes/payments");

const app = express();

app.use(cors());


app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Flowers Fill My Heart API"
  });
});


// PayPal webhook needs the raw request body for signature verification.
app.use(
"/api/payments/paypal-webhook",
express.raw({ type: "application/json" })
);

app.use(
  express.json({
    type: (req) => req.originalUrl !== "/api/payments/paypal-webhook"
  })
);

app.use("/api/accounts", accountRoutes);



app.use("/api/designs", designRoutes);

app.use("/api/payments", paymentRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Flowers Fill My Heart API running on port ${PORT}`);
});
