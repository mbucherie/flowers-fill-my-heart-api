const express = require("express");
const paypal = require("@paypal/paypal-server-sdk");

const pool = require("../db/connection");
const requireAuth = require("../middleware/auth");
const paypalClient = require("../config/paypal");

const router = express.Router();

const subscriptionsController =
  new paypal.SubscriptionsController(paypalClient);


// --------------------------------------------------
// CONFIRM PAYPAL SUBSCRIPTION
// --------------------------------------------------
router.post("/confirm-subscription", requireAuth, async (req, res) => {
  try {
    const { subscriptionId } = req.body;

    if (!subscriptionId || typeof subscriptionId !== "string") {
      return res.status(400).json({
        error: "PayPal subscription ID is required."
      });
    }

    // Ask PayPal for the actual subscription.
    const response = await subscriptionsController.getSubscription({
      id: subscriptionId
    });

    const subscription = response.result;

    if (!subscription || !subscription.id) {
      return res.status(400).json({
        error: "PayPal subscription could not be verified."
      });
    }

    // Make sure the returned subscription ID matches what was requested.
    if (subscription.id !== subscriptionId) {
      return res.status(400).json({
        error: "PayPal subscription verification failed."
      });
    }

    // Accept only an active PayPal subscription.
    if (subscription.status !== "ACTIVE") {
      return res.status(400).json({
        error: `PayPal subscription is not active. Current status: ${subscription.status || "UNKNOWN"}.`
      });
    }

    const paypalPlanId = subscription.planId;

    let subscriptionPlan = null;

    if (paypalPlanId === process.env.PAYPAL_MONTHLY_PLAN_ID) {
      subscriptionPlan = "monthly";
    } else if (paypalPlanId === process.env.PAYPAL_ANNUAL_PLAN_ID) {
      subscriptionPlan = "annual";
    } else {
      return res.status(400).json({
        error: "PayPal subscription uses an unrecognized plan."
      });
    }

    // Prevent the same PayPal subscription from being attached
    // to more than one Flowers Fill My Heart account.
    const [existingRows] = await pool.query(
      `SELECT id
       FROM users
       WHERE subscription_id = ?
         AND id <> ?
       LIMIT 1`,
      [subscriptionId, req.user.id]
    );

    if (existingRows.length > 0) {
      return res.status(409).json({
        error: "This PayPal subscription is already associated with another account."
      });
    }

   const startTime = subscription.startTime
  ? new Date(subscription.startTime)
  : new Date();

const nextBillingTime = subscription.billingInfo?.nextBillingTime
  ? new Date(subscription.billingInfo.nextBillingTime)
  : null;

    if (Number.isNaN(startTime.getTime())) {
      return res.status(500).json({
        error: "Invalid PayPal subscription start date."
      });
    }

    if (nextBillingTime && Number.isNaN(nextBillingTime.getTime())) {
      return res.status(500).json({
        error: "Invalid PayPal next billing date."
      });
    }

    await pool.query(
      `UPDATE users
       SET has_subscription = 1,
           subscription_provider = ?,
           subscription_id = ?,
           subscription_plan = ?,
           subscription_status = ?,
           subscription_start_date = ?,
           subscription_end_date = ?,
           subscription_cancelled_date = NULL,
           reactivation_deadline = NULL
       WHERE id = ?`,
      [
        "paypal",
        subscriptionId,
        subscriptionPlan,
        subscription.status,
        startTime,
        nextBillingTime,
        req.user.id
      ]
    );

    return res.status(200).json({
      message: "PayPal subscription confirmed successfully.",
      subscription: {
        id: subscriptionId,
        provider: "paypal",
        plan: subscriptionPlan,
        status: subscription.status,
        startDate: startTime,
        endDate: nextBillingTime
      }
    });

  } catch (error) {
    console.error(
      "CONFIRM PAYPAL SUBSCRIPTION ERROR:",
      error.body || error.message || error
    );

    return res.status(500).json({
      error: "Unable to confirm PayPal subscription."
    });
  }
});
// --------------------------------------------------
// CANCEL PAYPAL SUBSCRIPTION
// --------------------------------------------------
router.post("/cancel-subscription", requireAuth, async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT
         subscription_id,
         subscription_provider,
         subscription_status
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: "User account not found."
      });
    }

    const user = users[0];

    if (
      user.subscription_provider !== "paypal" ||
      !user.subscription_id
    ) {
      return res.status(400).json({
        error: "No active PayPal subscription was found for this account."
      });
    }

    if (user.subscription_status === "CANCELLED") {
      return res.status(400).json({
        error: "Your PayPal subscription is already cancelled."
      });
    }

    await subscriptionsController.cancelSubscription({
      id: user.subscription_id,
      body: {
        reason: "Customer requested cancellation."
      }
    });

    const cancelledAt = new Date();

    await pool.query(
      `UPDATE users
            SET   subscription_status = 'CANCELLED',
           subscription_cancelled_date = ?
       WHERE id = ?`,
      [
        cancelledAt,
        req.user.id
      ]
    );

    return res.status(200).json({
      message: "Your PayPal subscription has been cancelled.",
      subscription: {
        id: user.subscription_id,
        status: "CANCELLED",
        cancelledDate: cancelledAt
      }
    });

  } catch (error) {
    console.error(
      "CANCEL PAYPAL SUBSCRIPTION ERROR:",
      error.body || error.message || error
    );

    return res.status(500).json({
      error: "Unable to cancel PayPal subscription."
    });
  }
});


module.exports = router;