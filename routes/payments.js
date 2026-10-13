const express = require("express");
const paypal = require("@paypal/paypal-server-sdk");
const crypto = require("crypto");

const pool = require("../db/connection");
const requireAuth = require("../middleware/auth");
const paypalClient = require("../config/paypal");

const { sendEmail } = require("../utils/email");

const router = express.Router();
function generateAccountNumber() {
  return "FMH" + crypto.randomInt(10000000, 100000000);
}

async function generateUniqueAccountNumber() {
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

  return accountNumber;
}

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
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000)
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

  console.log("PAYPAL WEBHOOK VERIFY HEADERS:", {
  auth_algo: headers.auth_algo,
  cert_url: headers.cert_url,
  transmission_id: headers.transmission_id,
  transmission_time: headers.transmission_time,
  has_transmission_sig: Boolean(headers.transmission_sig),
  webhook_id: webhookId
});

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
,
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "PAYPAL WEBHOOK VERIFICATION ERROR:",
      response.status,
      errorText
    );

    throw new Error(
      `PayPal webhook verification service returned HTTP ${response.status}.`
    );
  }

  const data = await response.json();

  console.log("PAYPAL WEBHOOK VERIFY RESPONSE:", {
  status: response.status,
  verification_status: data.verification_status
});


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


async function getStoredSubscriptionAttemptById(attemptId) {
  const [rows] = await pool.query(
    `SELECT
       u.id,
       u.email,
       u.subscription_id,
       u.subscription_plan,
       u.subscription_status,
       u.subscription_start_date,
       u.subscription_end_date,
       u.subscription_cancelled_date,
       sa.id AS attempt_db_id,
       sa.attempt_id,
       sa.subscription_plan AS attempt_plan,
       sa.paypal_plan_id,
       sa.status AS attempt_status,
       sa.paypal_request_id,
       sa.paypal_subscription_id,
       sa.paypal_status_update_time
     FROM subscription_attempts sa
     INNER JOIN users u
       ON u.id = sa.user_id
     WHERE sa.attempt_id = ?
     LIMIT 1`,
    [attemptId]
  );

  return rows.length > 0 ? rows[0] : null;
}


async function getStoredPayPalUser(subscriptionId, customId) {
  if (customId) {
    const attempt =
      await getStoredSubscriptionAttemptById(customId);

    if (attempt) {
      if (
        attempt.paypal_subscription_id &&
        attempt.paypal_subscription_id !== subscriptionId
      ) {
        throw new Error(
          `PayPal subscription mismatch for attempt ${customId}.`
        );
      }

      return attempt;
    }
  }

  return getStoredUserBySubscriptionId(subscriptionId);
}


async function getPayPalSubscription(subscriptionId) {
  const response = await subscriptionsController.getSubscription({
    id: subscriptionId
  });

   
  return response.result;
}

// --------------------------------------------------
// PAYPAL SUBSCRIPTION RECONCILIATION
// --------------------------------------------------

async function reconcilePayPalSubscription({
  subscriptionId,
  expectedUserId = null,
  expectedAttemptId = null
}) {
  if (!subscriptionId) {
    throw new Error(
      "PayPal subscription ID is required for reconciliation."
    );
  }

  let connection = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ------------------------------------------------
    // 1. LOCK THE LOCAL SUBSCRIPTION ATTEMPT + USER
    // ------------------------------------------------

    let attemptRows;

    if (expectedAttemptId) {
      [attemptRows] = await connection.query(
        `SELECT
           sa.id AS attempt_db_id,
           sa.user_id,
           sa.attempt_id,
           sa.subscription_plan AS attempt_plan,
           sa.paypal_plan_id,
           sa.status AS attempt_status,
           sa.paypal_subscription_id,
           sa.paypal_status_update_time,
           u.id,
           u.email,
           u.account_number,
           u.has_subscription,
           u.subscription_provider,
           u.subscription_id,
           u.subscription_plan,
           u.subscription_status,
           u.subscription_start_date,
           u.subscription_end_date,
           u.subscription_cancelled_date,
           u.email_confirmed_at
         FROM subscription_attempts sa
         INNER JOIN users u
           ON u.id = sa.user_id
         WHERE sa.attempt_id = ?
         LIMIT 1
         FOR UPDATE`,
        [expectedAttemptId]
      );
    } else {
      [attemptRows] = await connection.query(
        `SELECT
           sa.id AS attempt_db_id,
           sa.user_id,
           sa.attempt_id,
           sa.subscription_plan AS attempt_plan,
           sa.paypal_plan_id,
           sa.status AS attempt_status,
           sa.paypal_subscription_id,
           sa.paypal_status_update_time,
           u.id,
           u.email,
           u.account_number,
           u.has_subscription,
           u.subscription_provider,
           u.subscription_id,
           u.subscription_plan,
           u.subscription_status,
           u.subscription_start_date,
           u.subscription_end_date,
           u.subscription_cancelled_date,
           u.email_confirmed_at
         FROM subscription_attempts sa
         INNER JOIN users u
           ON u.id = sa.user_id
         WHERE sa.paypal_subscription_id = ?
         LIMIT 1
         FOR UPDATE`,
        [subscriptionId]
      );
    }

    if (attemptRows.length === 0) {
      await connection.rollback();

      throw new Error(
        `No local subscription attempt found for PayPal subscription ${subscriptionId}.`
      );
    }

    const attempt = attemptRows[0];

    // ------------------------------------------------
    // 2. VERIFY USER OWNERSHIP WHEN EXPECTED
    // ------------------------------------------------

    if (
      expectedUserId !== null &&
      Number(attempt.user_id) !== Number(expectedUserId)
    ) {
      await connection.rollback();

      throw new Error(
        "PayPal subscription does not belong to the authenticated user."
      );
    }

    // ------------------------------------------------
    // 3. RETRIEVE PAYPAL'S CURRENT AUTHORITATIVE STATE
    // ------------------------------------------------

    const paypalSubscription =
      await getPayPalSubscription(subscriptionId);

    if (!paypalSubscription) {
      await connection.rollback();

      throw new Error(
        "Unable to retrieve the current PayPal subscription."
      );
    }

    if (
      paypalSubscription.id &&
      paypalSubscription.id !== subscriptionId
    ) {
      await connection.rollback();

      throw new Error(
        "PayPal returned a different subscription ID."
      );
    }

    // ------------------------------------------------
    // 4. VERIFY PAYPAL CORRELATION
    // ------------------------------------------------

    const paypalCustomId =
      paypalSubscription.customId || null;

    if (
      paypalCustomId &&
      paypalCustomId !== attempt.attempt_id
    ) {
      await connection.rollback();

      throw new Error(
        "PayPal subscription custom ID does not match the local subscription attempt."
      );
    }

    if (
      attempt.paypal_subscription_id &&
      attempt.paypal_subscription_id !== subscriptionId
    ) {
      await connection.rollback();

      throw new Error(
        "Local PayPal subscription ID does not match the subscription being reconciled."
      );
    }

    // ------------------------------------------------
    // 5. VERIFY PAYPAL PLAN
    // ------------------------------------------------

    if (
      paypalSubscription.planId &&
      paypalSubscription.planId !== attempt.paypal_plan_id
    ) {
      await connection.rollback();

      throw new Error(
        "PayPal subscription plan does not match the local subscription attempt."
      );
    }

    // ------------------------------------------------
    // 6. COMPARE PAYPAL STATE UPDATE TIME
    // ------------------------------------------------

    const paypalStatusUpdateTime =
      paypalSubscription.status_update_time
        ? new Date(paypalSubscription.status_update_time)
        : null;

    if (
      paypalStatusUpdateTime &&
      Number.isNaN(paypalStatusUpdateTime.getTime())
    ) {
      await connection.rollback();

      throw new Error(
        "PayPal returned an invalid subscription status update time."
      );
    }

    const storedStatusUpdateTime =
      attempt.paypal_status_update_time
        ? new Date(attempt.paypal_status_update_time)
        : null;

    if (
      storedStatusUpdateTime &&
      Number.isNaN(storedStatusUpdateTime.getTime())
    ) {
      await connection.rollback();

      throw new Error(
        "The stored PayPal subscription status update time is invalid."
      );
    }

    if (
      paypalStatusUpdateTime &&
      storedStatusUpdateTime &&
      paypalStatusUpdateTime <= storedStatusUpdateTime
    ) {
      await connection.commit();
      connection.release();
      connection = null;

      console.log(
        `PAYPAL RECONCILIATION: Ignoring stale PayPal state for ${subscriptionId}.`,
        {
          paypalStatus: paypalSubscription.status,
          paypalStatusUpdateTime:
            paypalSubscription.status_update_time,
          storedStatusUpdateTime:
            attempt.paypal_status_update_time
        }
      );

      return {
        reconciled: false,
        stale: true,
        subscriptionId,
        status: attempt.subscription_status,
        hasSubscription:
          Boolean(attempt.has_subscription),
        subscriptionEndDate:
          attempt.subscription_end_date || null
      };
    }

    // ------------------------------------------------
    // 7. DETERMINE THE CURRENT PAYPAL STATE
    // ------------------------------------------------

    const paypalStatus =
      paypalSubscription.status;

    const startDate =
      toMySQLDate(
        paypalSubscription.startTime
      );

    const nextBillingDate =
      toMySQLDate(
        paypalSubscription.billingInfo?.nextBillingTime
      );

    const finalPaymentDate =
      toMySQLDate(
        paypalSubscription.billingInfo?.finalPaymentTime
      );

    let hasSubscription = 0;
    let localStatus = paypalStatus;
    let subscriptionEndDate = null;
    let subscriptionCancelledDate = null;

    switch (paypalStatus) {
      case "ACTIVE":
        hasSubscription = 1;
        localStatus = "ACTIVE";
        subscriptionEndDate =
          nextBillingDate ||
          attempt.subscription_end_date ||
          null;
        break;

      case "SUSPENDED":
        hasSubscription = 0;
        localStatus = "SUSPENDED";
        subscriptionEndDate =
          attempt.subscription_end_date ||
          null;
        break;

      case "CANCELLED": {
        localStatus = "CANCELLED";

        subscriptionEndDate =
          finalPaymentDate ||
          nextBillingDate ||
          attempt.subscription_end_date ||
          null;

        subscriptionCancelledDate =
          toMySQLDate(
            paypalSubscription.status_update_time
          ) ||
          attempt.subscription_cancelled_date ||
          toMySQLDate(new Date());

        if (
          subscriptionEndDate &&
          new Date(subscriptionEndDate) >= new Date()
        ) {
          hasSubscription = 1;
        } else {
          hasSubscription = 0;
        }

        break;
      }

      case "EXPIRED":
        hasSubscription = 0;
        localStatus = "EXPIRED";
        subscriptionEndDate =
          attempt.subscription_end_date ||
          null;
        break;

      case "APPROVED":
      case "APPROVAL_PENDING":
        hasSubscription = 0;
        localStatus = paypalStatus;
        subscriptionEndDate =
          attempt.subscription_end_date ||
          null;
        break;

    default:
  throw new Error(
    `Unexpected PayPal subscription status: ${paypalStatus || "missing"}`
  );

      }


    // ------------------------------------------------
    // 8. ASSIGN ACCOUNT NUMBER ONLY WHEN ACTIVE
    // ------------------------------------------------

    let accountNumber =
      attempt.account_number || null;

    if (
      paypalStatus === "ACTIVE" &&
      !accountNumber
    ) {
      accountNumber =
        await generateUniqueAccountNumber();
    }

    // ------------------------------------------------
    // 9. UPDATE USER
    // ------------------------------------------------

    const [userUpdateResult] = await connection.query(
      `UPDATE users
       SET
         account_number =
           COALESCE(?, account_number),
         has_subscription = ?,
         subscription_provider = 'paypal',
         subscription_id = ?,
         subscription_plan = ?,
         subscription_status = ?,
         subscription_start_date =
           COALESCE(?, subscription_start_date),
         subscription_end_date = ?,
         subscription_cancelled_date = ?
       WHERE id = ?
         AND (
           subscription_id IS NULL
           OR subscription_id = ?
         )`,
      [
        accountNumber,
        hasSubscription,
        subscriptionId,
        attempt.attempt_plan,
        localStatus,
        startDate,
        subscriptionEndDate,
        subscriptionCancelledDate,
        attempt.user_id,
        subscriptionId
      ]
    );
    if (userUpdateResult.affectedRows !== 1) {
      throw new Error(
        `Unable to update user subscription state for PayPal subscription ${subscriptionId}.`
      );
    }

    // ------------------------------------------------
    // 10. UPDATE SUBSCRIPTION ATTEMPT
    // ------------------------------------------------

    await connection.query(
      `UPDATE subscription_attempts
       SET
         paypal_subscription_id = ?,
         status = ?,
         paypal_status_update_time = 
         COALESCE(?, paypal_status_update_time)
       WHERE id = ?`,
      [
        subscriptionId,
        localStatus,
        paypalStatusUpdateTime
          ? paypalStatusUpdateTime
          : null,
        attempt.attempt_db_id
      ]
    );

    await connection.commit();

    connection.release();
    connection = null;

    console.log(
      `PAYPAL RECONCILIATION: ${subscriptionId} -> ${paypalStatus}`,
      {
        userId: attempt.user_id,
        hasSubscription,
        subscriptionEndDate
      }
    );

    return {
      reconciled: true,
      stale: false,
      subscriptionId,
      status: localStatus,
      paypalStatus,
      hasSubscription: Boolean(hasSubscription),
      subscriptionPlan: attempt.attempt_plan,
      subscriptionStartDate:
        startDate ||
        attempt.subscription_start_date ||
        null,
      subscriptionEndDate,
      accountNumber
    };

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}

      connection.release();
      connection = null;
    }

    throw error;
  }
}

const subscriptionsController =
  new paypal.SubscriptionsController(paypalClient);


router.post("/create-subscription", requireAuth, async (req, res) => {
  const { plan } = req.body;

  if (plan !== "monthly" && plan !== "annual") {
    return res.status(400).json({
      error: "Invalid subscription plan.",
    });
  }

  const monthlyPlanId =
    process.env.PAYPAL_MODE === "live"
      ? process.env.PAYPAL_MONTHLY_PLAN_ID
      : "P-8G132203G8934612JNKI6WPY";

  const annualPlanId =
    process.env.PAYPAL_MODE === "live"
      ? process.env.PAYPAL_ANNUAL_PLAN_ID
      : "P-21K59382ES175315GNKI6XWA";

  const paypalPlanId =
    plan === "monthly" ? monthlyPlanId : annualPlanId;

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Lock this user row so two simultaneous checkout attempts
    // cannot create two different internal attempts.
    const [users] = await connection.query(
      `SELECT
         id,
         email_confirmed_at,
         has_subscription,
         subscription_status,
         subscription_end_date
       FROM users
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [req.user.id]
    );

    if (users.length === 0) {
      await connection.rollback();
      connection.release();

      return res.status(404).json({
        error: "Account not found.",
      });
    }

    const user = users[0];

    if (!user.email_confirmed_at) {
      await connection.rollback();
      connection.release();

      return res.status(403).json({
        error: "Please confirm your email address before continuing.",
        code: "EMAIL_NOT_CONFIRMED",
      });
    }

    // Do not allow creation of another PayPal subscription while
    // the current subscription is still active.
    const currentSubscriptionStillActive =
      user.has_subscription === 1 &&
      (
        user.subscription_status === "ACTIVE" ||
        (
          user.subscription_status === "CANCELLED" &&
          user.subscription_end_date &&
          new Date(user.subscription_end_date) >= new Date()
        )
      );

    if (currentSubscriptionStillActive) {
      await connection.rollback();
      connection.release();

      return res.status(409).json({
        error: "You already have an active subscription.",
      });
    }

    // Look for an existing checkout attempt for this user.
    // Reusing it is intentional: it preserves the same
    // PayPal-Request-Id and therefore the same PayPal operation.
    const [attempts] = await connection.query(
      `SELECT
         id,
         attempt_id,
         subscription_plan,
         paypal_plan_id,
         status,
         paypal_request_id,
         paypal_subscription_id
       FROM subscription_attempts
       WHERE user_id = ?
         AND status NOT IN ('FAILED', 'CANCELLED', 'EXPIRED')
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [req.user.id]
    );

    let attempt = attempts.length > 0 ? attempts[0] : null;

    if (attempt && attempt.subscription_plan !== plan) {
      await connection.rollback();
      connection.release();

      return res.status(409).json({
        error: "A subscription checkout is already in progress.",
      });
    }

    if (!attempt) {
      const attemptId = crypto.randomUUID();
      const paypalRequestId = crypto.randomUUID();

      await connection.query(
        `INSERT INTO subscription_attempts
         (
           user_id,
           attempt_id,
           subscription_plan,
           paypal_plan_id,
           status,
           paypal_request_id
         )
         VALUES (?, ?, ?, ?, 'PENDING', ?)`,
        [
          req.user.id,
          attemptId,
          plan,
          paypalPlanId,
          paypalRequestId,
        ]
      );

      attempt = {
        attempt_id: attemptId,
        subscription_plan: plan,
        paypal_plan_id: paypalPlanId,
        status: "PENDING",
        paypal_request_id: paypalRequestId,
        paypal_subscription_id: null,
      };
    }

    await connection.commit();
    connection.release();
    connection = null;

    // If PayPal already created the subscription, reuse it.
    if (attempt.paypal_subscription_id) {
      return res.status(200).json({
        subscriptionId: attempt.paypal_subscription_id,
        attemptId: attempt.attempt_id,
        status: attempt.status,
      });
    }

    console.log("CREATING PAYPAL SUBSCRIPTION ON SERVER");
    console.log("User ID:", req.user.id);
    console.log("Subscription attempt:", attempt.attempt_id);
    console.log("Selected plan:", plan);
    console.log("PayPal Plan ID:", attempt.paypal_plan_id);

    const paypalResponse =
      await subscriptionsController.createSubscription({
        paypalRequestId: attempt.paypal_request_id,
        body: {
          planId: attempt.paypal_plan_id,
          customId: attempt.attempt_id,
        },
      });

    const paypalSubscription = paypalResponse.result;

    if (!paypalSubscription?.id) {
      return res.status(502).json({
        error: "PayPal did not return a subscription ID.",
      });
    }

    // Store the exact PayPal subscription against the internal attempt.
    // Do not overwrite a terminal webhook status if the webhook won
    // the race and processed the subscription first.
    await pool.query(
      `UPDATE subscription_attempts
       SET
         paypal_subscription_id = ?,
         status = CASE
           WHEN status IN ('ACTIVE', 'CANCELLED', 'SUSPENDED', 'EXPIRED')
             THEN status
           ELSE 'APPROVAL_PENDING'
         END
       WHERE user_id = ?
         AND attempt_id = ?
         AND paypal_subscription_id IS NULL`,
      [
        paypalSubscription.id,
        req.user.id,
        attempt.attempt_id,
      ]
    );

    return res.status(200).json({
      subscriptionId: paypalSubscription.id,
      attemptId: attempt.attempt_id,
      status: paypalSubscription.status,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}
      connection.release();
    }

    console.error("PAYPAL CREATE SUBSCRIPTION ERROR:", error);

    return res.status(500).json({
      error: "Unable to create the PayPal subscription.",
    });
  }
});

// --------------------------------------------------
// CONFIRM PAYPAL SUBSCRIPTION
// --------------------------------------------------

router.post(
  "/confirm-subscription",
  requireAuth,
  async (req, res) => {
    const { subscriptionId } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({
        error: "PayPal subscription ID is required."
      });
    }

    try {
      // Retrieve the subscription directly from PayPal.
      const paypalSubscription =
        await getPayPalSubscription(subscriptionId);

      if (!paypalSubscription) {
        return res.status(400).json({
          error: "Unable to retrieve PayPal subscription."
        });
      }

      // PayPal custom_id must identify the internal
      // subscription attempt created for this user.
      const customId =
        paypalSubscription.customId;

      if (!customId) {
        return res.status(400).json({
          error:
            "PayPal subscription could not be correlated to this checkout."
        });
      }

      // Find the exact pending attempt belonging to
      // the authenticated user.
      const [attemptRows] = await pool.query(
        `SELECT
           sa.id,
           sa.attempt_id,
           sa.user_id,
           sa.subscription_plan,
           sa.paypal_plan_id,
           sa.status AS attempt_status,
           sa.paypal_subscription_id,
           u.has_subscription,
           u.subscription_id,
           u.subscription_status,
           u.account_number,
           u.email_confirmed_at
         FROM subscription_attempts sa
         INNER JOIN users u
           ON u.id = sa.user_id
         WHERE sa.attempt_id = ?
           AND sa.user_id = ?
         LIMIT 1`,
        [
          customId,
          req.user.id
        ]
      );

      if (attemptRows.length === 0) {
        return res.status(403).json({
          error:
            "This PayPal subscription does not belong to your checkout."
        });
      }

      const attempt = attemptRows[0];

      if (!attempt.email_confirmed_at) {
        return res.status(403).json({
          error:
            "Please confirm your email address before continuing.",
          code: "EMAIL_NOT_CONFIRMED"
        });
      }

      // The PayPal subscription ID must match the
      // subscription created for this exact attempt.
      if (
        attempt.paypal_subscription_id &&
        attempt.paypal_subscription_id !== subscriptionId
      ) {
        return res.status(409).json({
          error:
            "PayPal subscription could not be matched to this checkout.",
          code: "SUBSCRIPTION_MISMATCH"
        });
      }

      // The PayPal plan must match the plan selected
      // for the internal checkout attempt.
      const monthlyPlanId =
        process.env.PAYPAL_MODE === "live"
          ? process.env.PAYPAL_MONTHLY_PLAN_ID
          : "P-8G132203G8934612JNKI6WPY";

      const annualPlanId =
        process.env.PAYPAL_MODE === "live"
          ? process.env.PAYPAL_ANNUAL_PLAN_ID
          : "P-21K59382ES175315GNKI6XWA";

      if (
        attempt.subscription_plan === "monthly" &&
        paypalSubscription.planId !== monthlyPlanId
      ) {
        return res.status(409).json({
          error:
            "The PayPal subscription plan does not match your selected plan.",
          code: "SUBSCRIPTION_PLAN_MISMATCH"
        });
      }

      if (
        attempt.subscription_plan === "annual" &&
        paypalSubscription.planId !== annualPlanId
      ) {
        return res.status(409).json({
          error:
            "The PayPal subscription plan does not match your selected plan.",
          code: "SUBSCRIPTION_PLAN_MISMATCH"
        });
      }

      // Keep the internal attempt synchronized with the
      // exact PayPal subscription, but do NOT activate the
      // local user here.
      await pool.query(
        `UPDATE subscription_attempts
         SET
           paypal_subscription_id =
             COALESCE(paypal_subscription_id, ?),
           status =
             CASE
               WHEN status = 'PENDING'
                 THEN 'APPROVAL_PENDING'
               ELSE status
             END
         WHERE id = ?
           AND user_id = ?
           AND (
             paypal_subscription_id IS NULL
             OR paypal_subscription_id = ?
           )`,
        [
          subscriptionId,
          attempt.id,
          req.user.id,
          subscriptionId
        ]
      );

      // ------------------------------------------------
      // IMPORTANT:
      // PayPal approval does NOT activate Premium.
      // Only the verified webhook may do that.
      // ------------------------------------------------

      if (
        paypalSubscription.status === "ACTIVE" &&
        attempt.has_subscription === 1 &&
        attempt.subscription_id === subscriptionId &&
        attempt.subscription_status === "ACTIVE"
      ) {
        return res.status(200).json({
          message:
            "Your subscription has been verified.",
          verified: true,
          verificationPending: false,
          accountNumber: attempt.account_number,
          subscription: {
            id: subscriptionId,
            plan: attempt.subscription_plan,
            status: "ACTIVE"
          }
        });
      }

      if (
        paypalSubscription.status === "CANCELLED" ||
        paypalSubscription.status === "EXPIRED" ||
        paypalSubscription.status === "SUSPENDED"
      ) {
        return res.status(409).json({
          error:
            "Your PayPal subscription could not be verified as active.",
          code: "SUBSCRIPTION_NOT_ACTIVE",
          verified: false,
          verificationPending: false,
          subscription: {
            id: subscriptionId,
            plan: attempt.subscription_plan,
            status: paypalSubscription.status
          }
        });
      }

      // PayPal may be approved/created while the
      // authoritative activation webhook is still pending.
      return res.status(200).json({
        message:
          "Your PayPal subscription has been received and is being verified.",
        verified: false,
        verificationPending: true,
        subscription: {
          id: subscriptionId,
          plan: attempt.subscription_plan,
          status: paypalSubscription.status
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
        error: "Unable to verify subscription."
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
   async (req, res) => {
    console.log("PAYPAL WEBHOOK ROUTE REACHED");
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

const customId =
  resource?.custom_id || null;

const user =
  await getStoredPayPalUser(
    subscriptionId,
    customId
  );

if (!user) {
  console.log(
    `PAYPAL WEBHOOK: No local user found for subscription ${subscriptionId}.`
  );

  // This may be a valid PayPal event that does not
  // belong to a Flowers Fill My Heart checkout.
  return res.status(200).json({
    received: true,
    processed: false,
    eventType
  });
}

// ------------------------------------------------
// 6. STATE RECONCILIATION IS HANDLED BELOW
// ------------------------------------------------
//
// State-changing subscription events use
// reconcilePayPalSubscription(), which retrieves
// PayPal's current authoritative state and manages
// its own database transaction.
//
// CREATED and non-state-changing events continue
// through the webhook transaction below.

console.log("PAYPAL WEBHOOK: Signature verified");

   
// ------------------------------------------------
// 7. RECONCILE PAYPAL SUBSCRIPTION STATE
// ------------------------------------------------

if (requiresPayPalSubscriptionLookup(eventType)) {
  try {
    const reconciliationResult =
      await reconcilePayPalSubscription({
        subscriptionId,
        expectedUserId: user.id,
        expectedAttemptId: user.attempt_id || null
      });

    console.log(
      `PAYPAL WEBHOOK: Reconciliation completed for ${subscriptionId}.`,
      reconciliationResult
    );
  } catch (reconciliationError) {
    console.error(
      `PAYPAL WEBHOOK: Reconciliation failed for ${subscriptionId}:`,
      reconciliationError.message
    );

    throw reconciliationError;
  }
} else if (
  eventType === "BILLING.SUBSCRIPTION.CREATED"
) {
  // Creation alone does not grant Premium.
  // The subscription remains pending until PayPal
  // reaches an authoritative active state.

  console.log(
    `PAYPAL WEBHOOK: Subscription created ${subscriptionId}.`
  );
} else if (
  eventType === "PAYMENT.SALE.COMPLETED"
) {
  // This is a payment notification.
  // It deliberately does not change subscription state.

  console.log(
    `PAYPAL WEBHOOK: Sale completed for subscription ${subscriptionId}.`
  );
} else {
  // Unknown webhook event types are ignored.
  //
  // They must never create an UNKNOWN subscription
  // state for the customer.

  console.log(
    `PAYPAL WEBHOOK: Event ignored: ${eventType}`
  );
}
// ------------------------------------------------
// 8. RECORD SUCCESSFULLY PROCESSED WEBHOOK
// ------------------------------------------------

connection = await pool.getConnection();

try {
  await connection.beginTransaction();

  await connection.query(
    `INSERT INTO paypal_webhook_events
      (
        event_id,
        event_type,
        subscription_id,
        user_id,
        attempt_id,
        paypal_status,
        transmission_time,
        processed_at,
        processing_status
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      eventType,
      subscriptionId,
      user.id,
      user.attempt_id || null,
      null,
      webhookEvent?.create_time
        ? toMySQLDate(webhookEvent.create_time)
        : null,
      toMySQLDate(new Date()),
      "PROCESSED"
    ]
  );

  await connection.commit();

  connection.release();
  connection = null;
} catch (recordError) {
  try {
    await connection.rollback();
  } catch (rollbackError) {
    console.error(
      "PAYPAL WEBHOOK RECORD ROLLBACK ERROR:",
      rollbackError
    );
  }

  connection.release();
  connection = null;

   if (recordError.code === "ER_DUP_ENTRY") {
    console.log(
      `PAYPAL WEBHOOK: Duplicate event already recorded: ${eventId}`
    );

    return res.status(200).json({
      received: true,
      processed: false,
      duplicate: true,
      eventType
    });
  }


  throw recordError;
}

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


