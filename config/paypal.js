const {
  Client,
  Environment,
} = require("@paypal/paypal-server-sdk");

const paypalClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment:
    process.env.PAYPAL_MODE === "live"
      ? Environment.Production
      : Environment.Sandbox,
  timeout: 30000,
});

module.exports = paypalClient;
