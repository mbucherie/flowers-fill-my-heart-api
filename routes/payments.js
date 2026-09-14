const express = require("express");
const paypal = require("@paypal/paypal-server-sdk");

const pool = require("../db/connection");
const requireAuth = require("../middleware/auth");
const paypalClient = require("../config/paypal");

const router = express.Router();

const PAYPAL_BASE_URL =
  process.env.PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

async function getPayPalAccessToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  if (!response.ok) {
    throw new Error("Unable to obtain PayPal access token.");
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("PayPal access token was not returned.");
  }

  return data.access_token;
}


// --------------------------------------------------
// PAYPAL WEBHOOK
// -------------------------------------------

async function verifyPayPalWebhook(req, webhookEvent) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    throw new Error("PAYPAL_WEBHOOK_ID is not configured.");
  }

  const headers = {
    auth_algo: req.headers["paypal-auth-algo"],
    cert_url: req.headers["paypal-cert-url"],
    transmission_id: req.headers["paypal-transmission-id"],
    transmission_sig: req.headers["paypal-transmission-sig"],
    transmission_time: req.headers["paypal-transmission-time"]
  };

    if (
    !headers.auth_algo ||
    !headers.cert_url ||
    !headers.transmission_id ||
    !headers.transmission_sig ||
    !headers.transmission_time
  ) {
    return false;
  }

  const transmissionTime = new Date(headers.transmission_time);

  if (Number.isNaN(transmissionTime.getTime())) {
    console.error("PAYPAL WEBHOOK REJECTED: Invalid transmission time.");
    return false;
  }

  const ageMs = Math.abs(Date.now() - transmissionTime.getTime());
  const fiveMinutesMs = 5 * 60 * 1000;

  if (ageMs > fiveMinutesMs) {
    console.error(
      "PAYPAL WEBHOOK REJECTED: Transmission time outside 5-minute window.",
      headers.transmission_time
    );

    return false;
  }

  let certUrl;

  try {
    certUrl = new URL(headers.cert_url);
  } catch {
    console.error("PAYPAL WEBHOOK REJECTED: Invalid certificate URL.");
    return false;
  }

  const expectedCertHost =
    process.env.PAYPAL_MODE === "live"
      ? "api.paypal.com"
      : "api.sandbox.paypal.com";

  if (
    certUrl.protocol !== "https:" ||
    certUrl.hostname !== expectedCertHost
  ) {
    console.error(
      "PAYPAL WEBHOOK REJECTED: Untrusted certificate URL.",
      headers.cert_url
    );

    return false;
  }

  

  const accessToken = await getPayPalAccessToken();
  const response = await fetch(
    `${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...headers,
        webhook_id: webhookId,
        webhook_event: webhookEvent
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "PAYPAL WEBHOOK VERIFICATION ERROR:",
      response.status,
      errorText
    );

    return false;
  }

  const data = await response.json();

  return data.verification_status === "SUCCESS";
}

function toMySQLDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}


async function getStoredUserBySubscriptionId(subscriptionId) {
  const [rows] = await pool.query(
    `SELECT
       id,
       subscription_id,
       subscription_plan,
       subscription_status,
       subscription_start_date,
       subscription_end_date,
       subscription_cancelled_date
       
     FROM users
     WHERE subscription_id = ?
       AND subscription_provider = 'paypal'
     LIMIT 1`,
    [subscriptionId]
  );

  return rows.length > 0 ? rows[0] : null;
}

async function getPayPalSubscription(subscriptionId) {
  const response = await subscriptionsController.getSubscription({
    id: subscriptionId
  });

   
  return response.result;
}

const subscriptionsController =
  new paypal.SubscriptionsController(paypalClient);

// --------------------------------------------------
// CONFIRM PAYPAL SUBSCRIPTION
// --------------------------------------------------

router.post(
  "/confirm-subscription",
  requireAuth,
  async (req, res) => {
    try {
      const { subscriptionId } = req.body;

      if (!subscriptionId) {
        return res.status(400).json({
          error: "PayPal subscription ID is required."
        });
      }

      // Retrieve the subscription directly from PayPal.
      const paypalSubscription =
        await getPayPalSubscription(subscriptionId);

      if (!paypalSubscription) {
        return res.status(400).json({
          error: "Unable to retrieve PayPal subscription."
        });
      }

      // The subscription must belong to the PayPal
      // account/environment configured for this server.
      const planId = paypalSubscription.planId;

      if (!planId) {
        return res.status(400).json({
          error: "PayPal subscription plan could not be determined."
        });
      }

      let subscriptionPlan = null;

      if (
        planId === "P-8G132203G8934612JNKI6WPY"
      ) {
        subscriptionPlan = "monthly";
      } else if (
        planId === "P-21K59382ES175315GNKI6XWA"
      ) {
        subscriptionPlan = "annual";
      } else {
        return res.status(400).json({
          error: "Unknown PayPal subscription plan."
        });
      }

      const subscriptionStatus =
        paypalSubscription.status;

      const startDate = toMySQLDate(
        paypalSubscription.startTime
      );

      const endDate = toMySQLDate(
        paypalSubscription
          .billingInfo
          ?.nextBillingTime
      );

      // Associate this PayPal subscription with the
      // authenticated local account.
    await pool.query(
  `UPDATE users
   SET has_subscription = ?,
       subscription_provider = 'paypal',
       subscription_id = ?,
       subscription_plan = ?,
       subscription_status = ?,
       subscription_start_date = ?,
       subscription_end_date = ?,
       subscription_cancelled_date = NULL
   WHERE id = ?`,
  [
    subscriptionStatus === "ACTIVE" ? 1 : 0,
    subscriptionId,
    subscriptionPlan,
    subscriptionStatus,
    startDate,
    endDate,
    req.user.id
  ]
);

      return res.status(200).json({
        message: "Subscription confirmed.",
        subscription: {
          id: subscriptionId,
          plan: subscriptionPlan,
          status: subscriptionStatus,
          startDate,
          endDate
        }
      });

    } catch (error) {
      console.error(
        "CONFIRM SUBSCRIPTION ERROR:",
        error.body ||
        error.response?.body ||
        error.message ||
        error
      );

      return res.status(500).json({
        error: "Unable to confirm subscription."
      });
    }
  }
);


// --------------------------------------------------
// CANCEL PAYPAL SUBSCRIPTION
// --------------------------------------------------

router.post(
  "/cancel-subscription",
  requireAuth,
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           subscription_id,
           subscription_provider,
           subscription_status
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "User account not found."
        });
      }

      const userSubscription = rows[0];

      if (
        userSubscription.subscription_provider !== "paypal" ||
        !userSubscription.subscription_id
      ) {
        return res.status(400).json({
          error: "No active PayPal subscription was found."
        });
      }

      const subscriptionId =
        userSubscription.subscription_id;

      const paypalSubscription =
        await getPayPalSubscription(subscriptionId);

      if (!paypalSubscription) {
        return res.status(400).json({
          error: "Unable to retrieve PayPal subscription."
        });
      }

      if (
        paypalSubscription.status === "CANCELLED" ||
        paypalSubscription.status === "EXPIRED"
      ) {
        return res.status(400).json({
          error: "This subscription is no longer active."
        });
      }

      const accessToken =
        await getPayPalAccessToken();

      const response = await fetch(
        `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${encodeURIComponent(
          subscriptionId
        )}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            cancel_option: "END_OF_PERIOD"
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();

        console.error(
          "PAYPAL CANCEL SUBSCRIPTION ERROR:",
          response.status,
          errorText
        );

        return res.status(400).json({
          error: "Unable to cancel PayPal subscription."
        });
      }

      console.log(
        `PAYPAL SUBSCRIPTION CANCELLATION REQUESTED: ${subscriptionId}`
      );

      return res.status(200).json({
        message:
          "Subscription cancellation requested.",
        subscriptionId
      });

    } catch (error) {
      console.error(
        "CANCEL SUBSCRIPTION ERROR:",
        error.body ||
        error.response?.body ||
        error.message ||
        error
      );

      return res.status(500).json({
        error: "Unable to cancel subscription."
      });
    }
  }
);


// --------------------------------------------------
// EVENT-SPECIFIC SUBSCRIPTION ID EXTRACTION
// --------------------------------------------------

function getSubscriptionIdFromWebhook(eventType, resource) {
  switch (eventType) {
    // Subscription webhook events:
    // The subscription ID is resource.id.
    case "BILLING.SUBSCRIPTION.CREATED":
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
    case "BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED": 
      return resource?.id || null;

    // Recurring subscription payment event:
    // PayPal's PAYMENT.SALE.COMPLETED payload uses
    // billing_agreement_id for the subscription ID.
    case "PAYMENT.SALE.COMPLETED":
      return resource?.billing_agreement_id || null;

    default:
      return null;
  }
}


// --------------------------------------------------
// EVENTS THAT REQUIRE CURRENT PAYPAL SUBSCRIPTION
// --------------------------------------------------

function requiresPayPalSubscriptionLookup(eventType) {
  switch (eventType) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
    case "BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED":
    return true;
 
    default:
      return false;
  }
}


// --------------------------------------------------
// PAYPAL WEBHOOK ROUTE
// --------------------------------------------------

router.post(
  "/paypal-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
        let connection = null; 

         try {
     
      // ------------------------------------------------
      // 1. PRESERVE THE RAW BODY
      // ------------------------------------------------

      if (!Buffer.isBuffer(req.body)) {
        console.error("PAYPAL WEBHOOK: Raw request body is missing.");

        return res.status(400).json({
          error: "Invalid webhook request body."
        });
      }

      const rawBody = req.body.toString("utf8");

      let webhookEvent;

      try {
        webhookEvent = JSON.parse(rawBody);
      } catch (error) {
        console.error(
          "PAYPAL WEBHOOK: Invalid JSON:",
          error.message
        );

        return res.status(400).json({
          error: "Invalid webhook JSON."
        });
      }

      // ------------------------------------------------
      // 2. VERIFY PAYPAL SIGNATURE FIRST
      // ------------------------------------------------

      const verified = await verifyPayPalWebhook(
        req,
        webhookEvent
      );

      if (!verified) {
        console.error(
          "PAYPAL WEBHOOK: Signature verification failed."
        );

        return res.status(400).json({
          error: "Invalid PayPal webhook signature."
        });
      }

      // ------------------------------------------------
      // 3. READ EVENT
      // ------------------------------------------------

      const eventType = webhookEvent?.event_type;
      const resource = webhookEvent?.resource || {};
      const eventId = webhookEvent?.id;

      if (!eventType) {
        return res.status(200).json({
          received: true,
          processed: false,
          reason: "Missing event type."
        });
      }

      console.log(
        `PAYPAL WEBHOOK RECEIVED: ${eventType}`
      );

       if (!eventId) {
        console.error(
          "PAYPAL WEBHOOK: Missing event ID."
        );

        return res.status(400).json({
          error: "Missing PayPal webhook event ID."
        });
      }


      // ------------------------------------------------
      // 3A. CHECK FOR DUPLICATE WEBHOOK
      // ------------------------------------------------

      const [existingWebhookEvents] =
        await pool.query(
          `SELECT id
           FROM paypal_webhook_events
           WHERE event_id = ?
           LIMIT 1`,
          [eventId]
        );

      if (existingWebhookEvents.length > 0) {
        console.log(
          `PAYPAL WEBHOOK: Duplicate event ignored: ${eventId}`
        );

        return res.status(200).json({
          received: true,
          processed: false,
          duplicate: true,
          eventType
        });
      }

      // ------------------------------------------------
      // 4. EXTRACT SUBSCRIPTION ID FOR THIS EVENT
      // ------------------------------------------------

      const subscriptionId =
        getSubscriptionIdFromWebhook(
          eventType,
          resource
        );

      // Events that are not subscription events do not
      // need to be processed by this route.
      if (!subscriptionId) {
        console.log(
          `PAYPAL WEBHOOK IGNORED: ${eventType} has no subscription ID.`
        );

        return res.status(200).json({
          received: true,
          processed: false,
          eventType
        });
      }

      // ------------------------------------------------
      // 5. FIND LOCAL USER
      // ------------------------------------------------

      const user =
        await getStoredUserBySubscriptionId(
          subscriptionId
        );

      if (!user) {
        console.log(
          `PAYPAL WEBHOOK: No local user found for subscription ${subscriptionId}.`
        );

        // The event is valid and was successfully received.
        // The subscription simply has not been associated
        // with a local account yet.
        return res.status(200).json({
          received: true,
          processed: false,
          eventType
        });
      }

      // ------------------------------------------------
      // 6. GET CURRENT PAYPAL SUBSCRIPTION WHEN NEEDED
      // ------------------------------------------------

      let paypalSubscription = null;

      if (
        requiresPayPalSubscriptionLookup(eventType)
      ) {
        paypalSubscription =
          await getPayPalSubscription(
            subscriptionId
          );
      }

      // ------------------------------------------------
      // 7. HANDLE EACH EVENT DELIBERATELY
      // ------------------------------------------------

      connection = await pool.getConnection();

      console.log("PAYPAL WEBHOOK: Signature verified");

      await connection.beginTransaction();

      switch (eventType) {

        // ----------------------------------------------
        // SUBSCRIPTION CREATED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.CREATED": {
          // Creation alone does not grant Premium access.
          // confirm-subscription / ACTIVATED handles activation.

          console.log(
            `PAYPAL WEBHOOK: Subscription created ${subscriptionId}.`
          );

          break;
        }


        // ----------------------------------------------
        // SUBSCRIPTION ACTIVATED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.ACTIVATED": {
          if (
            !paypalSubscription ||
            paypalSubscription.status !== "ACTIVE"
          ) {
            console.error(
              `PAYPAL WEBHOOK: ACTIVATED event but PayPal subscription is not ACTIVE: ${subscriptionId}`
            );

            break;
          }

          const startDate = toMySQLDate(
            paypalSubscription.startTime
          );

          const endDate = toMySQLDate(
            paypalSubscription.billingInfo?.nextBillingTime
          );

          await connection.query(
            `UPDATE users
             SET has_subscription = 1,
                 subscription_status = 'ACTIVE',
                 subscription_start_date =
                   COALESCE(?, subscription_start_date),
                 subscription_end_date =
                   COALESCE(?, subscription_end_date),
                 subscription_cancelled_date = NULL
                 
             WHERE id = ?
               AND subscription_id = ?
               AND subscription_provider = 'paypal'`,
            [
              startDate,
              endDate,
              user.id,
              subscriptionId
            ]
          );

          console.log(
            `PAYPAL WEBHOOK: Subscription activated ${subscriptionId}.`
          );

          break;
        }


        // ----------------------------------------------
        // SUBSCRIPTION UPDATED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.UPDATED": {
          if (!paypalSubscription) {
            break;
          }

          const paypalStatus =
            paypalSubscription.status;

          const nextBillingDate =
            toMySQLDate(
              paypalSubscription
                .billingInfo
                ?.nextBillingTime
            );

          const startDate =
            toMySQLDate(
              paypalSubscription.startTime
            );

          // Only synchronize known PayPal states.
          if (
            paypalStatus === "ACTIVE"
          ) {
            await connection.query(
              `UPDATE users
               SET has_subscription = 1,
                   subscription_status = 'ACTIVE',
                   subscription_start_date =
                     COALESCE(?, subscription_start_date),
                   subscription_end_date =
                     COALESCE(?, subscription_end_date),
                   subscription_cancelled_date = NULL
                 
               WHERE id = ?
                 AND subscription_id = ?
                 AND subscription_provider = 'paypal'`,
              [
                startDate,
                nextBillingDate,
                user.id,
                subscriptionId
              ]
            );
          } else if (
            paypalStatus === "SUSPENDED"
          ) {
            await connection.query(
              `UPDATE users
               SET subscription_status = 'SUSPENDED'
               WHERE id = ?
                 AND subscription_id = ?
                 AND subscription_provider = 'paypal'`,
              [
                user.id,
                subscriptionId
              ]
            );
          } else if (
            paypalStatus === "CANCELLED"
          ) {
            const endDate =
              nextBillingDate ||
              user.subscription_end_date;

            await connection.query(
              `UPDATE users
               SET subscription_status = 'CANCELLED',
                   subscription_end_date =
                     COALESCE(?, subscription_end_date),
                   subscription_cancelled_date =
                     COALESCE(
                       subscription_cancelled_date,
                       CURRENT_DATE
                     )
                   
               WHERE id = ?
                 AND subscription_id = ?
                 AND subscription_provider = 'paypal'`,
              [
                endDate,
                user.id,
                subscriptionId
              ]
            );
          } else if (
            paypalStatus === "EXPIRED"
          ) {
            await connection.query(
              `UPDATE users
               SET has_subscription = 0,
                   subscription_status = 'EXPIRED'
               WHERE id = ?
                 AND subscription_id = ?
                 AND subscription_provider = 'paypal'`,
              [
                user.id,
                subscriptionId
              ]
            );
          }

          console.log(
            `PAYPAL WEBHOOK: Subscription updated ${subscriptionId} -> ${paypalStatus}`
          );

          break;
        }


        // ----------------------------------------------
        // PAYMENT SUCCEEDED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED": {
          if (!paypalSubscription) {
            break;
          }

          const paypalStatus =
            paypalSubscription.status;

          const nextBillingDate =
            toMySQLDate(
              paypalSubscription
                .billingInfo
                ?.nextBillingTime
            );

          // A successful payment should not blindly
          // reactivate a subscription.
          //
          // We use PayPal's CURRENT subscription status
          // as the authority.

          if (
            paypalStatus === "ACTIVE"
          ) {
            await connection.query(
              `UPDATE users
               SET has_subscription = 1,
                   subscription_status = 'ACTIVE',
                   subscription_end_date =
                     COALESCE(?, subscription_end_date),
                   subscription_cancelled_date = NULL
                  
               WHERE id = ?
                 AND subscription_id = ?
                 AND subscription_provider = 'paypal'`,
              [
                nextBillingDate,
                user.id,
                subscriptionId
              ]
            );
          }

          console.log(
            `PAYPAL WEBHOOK: Payment succeeded for ${subscriptionId}. Current PayPal status: ${paypalStatus}`
          );

          break;
        }


        // ----------------------------------------------
        // PAYMENT.SALE.COMPLETED
        // ----------------------------------------------

        case "PAYMENT.SALE.COMPLETED": {
          // This is a payment notification.
          //
          // billing_agreement_id is the subscription ID
          // for this event format.
          //
          // We deliberately DO NOT change the local
          // subscription state here.
          //
          // The subscription lifecycle events are
          // responsible for subscription state.

          console.log(
            `PAYPAL WEBHOOK: Sale completed for subscription ${subscriptionId}.`
          );

          break;
        }


        // ----------------------------------------------
        // PAYMENT FAILED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
          if (!paypalSubscription) {
            break;
          }

          const paypalStatus =
            paypalSubscription.status;

          // A failed payment is NOT automatically treated
          // as SUSPENDED.
          //
          // PayPal's current subscription status is the
          // authoritative state.

          if (
            paypalStatus === "SUSPENDED"
          ) {
            await connection.query(
              `UPDATE users
               SET subscription_status = 'SUSPENDED'
               WHERE id = ?
                 AND subscription_id = ?
                 AND subscription_provider = 'paypal'`,
              [
                user.id,
                subscriptionId
              ]
            );
          }

          console.log(
            `PAYPAL WEBHOOK: Payment failed for ${subscriptionId}. Current PayPal status: ${paypalStatus}`
          );

          break;
        }


        // ----------------------------------------------
        // SUBSCRIPTION CANCELLED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.CANCELLED": {
          if (!paypalSubscription) {
            break;
          }

          const endDate =
            toMySQLDate(
              paypalSubscription
                .billingInfo
                ?.nextBillingTime
            ) ||
            user.subscription_end_date;

        
          await connection.query(
            `UPDATE users
             SET has_subscription = 1,
                 subscription_status = 'CANCELLED',
                 subscription_end_date =
                   COALESCE(?, subscription_end_date),
                 subscription_cancelled_date =
                   COALESCE(
                     subscription_cancelled_date,
                     CURRENT_DATE
                   )
                 
             WHERE id = ?
               AND subscription_id = ?
               AND subscription_provider = 'paypal'`,
            [
              endDate,
              user.id,
              subscriptionId
            ]
          );

          console.log(
            `PAYPAL WEBHOOK: Subscription cancelled ${subscriptionId}.`
          );

          break;
        }


        // ----------------------------------------------
        // SUBSCRIPTION SUSPENDED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.SUSPENDED": {
          await connection.query(
            `UPDATE users
             SET subscription_status = 'SUSPENDED'
             WHERE id = ?
               AND subscription_id = ?
               AND subscription_provider = 'paypal'`,
            [
              user.id,
              subscriptionId
            ]
          );

          console.log(
            `PAYPAL WEBHOOK: Subscription suspended ${subscriptionId}.`
          );

          break;
        }


        // ----------------------------------------------
        // SUBSCRIPTION EXPIRED
        // ----------------------------------------------

        case "BILLING.SUBSCRIPTION.EXPIRED": {
          await connection.query(
            `UPDATE users
             SET has_subscription = 0,
                 subscription_status = 'EXPIRED'
             WHERE id = ?
               AND subscription_id = ?
               AND subscription_provider = 'paypal'`,
            [
              user.id,
              subscriptionId
            ]
          );

          console.log(
            `PAYPAL WEBHOOK: Subscription expired ${subscriptionId}.`
          );

          break;
        }


        // ----------------------------------------------
        // UNKNOWN EVENT
        // ----------------------------------------------

        default: {
          console.log(
            `PAYPAL WEBHOOK: Event ignored: ${eventType}`
          );

          break;
        }
      }

      // ------------------------------------------------
      // 8. RECORD SUCCESSFULLY PROCESSED WEBHOOK
      // ------------------------------------------------

      await connection.query(
        `INSERT INTO paypal_webhook_events
           (event_id, event_type)
         VALUES (?, ?)`,
        [eventId, eventType]
      );

     await connection.commit();

     connection.release();
     connection = null;

      // ------------------------------------------------
      // 9. SUCCESSFUL RECEIPT
      // ------------------------------------------------

      return res.status(200).json({
        received: true,
        processed: true,
        eventType,
        subscriptionId
      });

    } catch (error) {
      if (connection) {
       try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
         "PAYPAL WEBHOOK ROLLBACK ERROR:",
        rollbackError
      );
    }

    connection.release();
    connection = null;
  }


      console.error(
        "PAYPAL WEBHOOK ERROR:",
        error.body ||
        error.response?.body ||
        error.message ||
        error
      );

      return res.status(500).json({
        error: "Unable to process PayPal webhook."
      });
    }
  }
);


module.exports = router;