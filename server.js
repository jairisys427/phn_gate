// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { Cashfree } from "cashfree-pg"; // Import Cashfree SDK

import { createPendingOrder, updateOrderStatus, getOrderByMerchantId } from "./db.js";

dotenv.config();

/* ----------------------------------------
   Helpers
----------------------------------------- */
const trim = (v) => (typeof v === "string" ? v.trim() : v);

/* ----------------------------------------
   Load and validate env
----------------------------------------- */
const APP_ID = trim(process.env.CASHFREE_APP_ID || "");
const SECRET_KEY = trim(process.env.CASHFREE_SECRET_KEY || "");
const CASHFREE_ENV = trim(process.env.CASHFREE_ENV || "SANDBOX").toUpperCase();

if (!APP_ID || !SECRET_KEY) {
  console.error("Missing Cashfree config (APP_ID or SECRET_KEY) in .env");
  process.exit(1);
}

/* ----------------------------------------
   Initialize Cashfree SDK
----------------------------------------- */
Cashfree.XClientId = APP_ID;
Cashfree.XClientSecret = SECRET_KEY;
Cashfree.XEnvironment = CASHFREE_ENV === "PRODUCTION" ? Cashfree.Environment.PRODUCTION : Cashfree.Environment.SANDBOX;

console.log(`Initializing Cashfree SDK in ${CASHFREE_ENV} mode`);

/* ----------------------------------------
   Express App
----------------------------------------- */
const app = express();

// Middleware to capture raw body for Webhook Verification
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

/* ----------------------------------------
   CORS
----------------------------------------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0] || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 5000;

/* ----------------------------------------
   1) Create Order (Cashfree)
----------------------------------------- */
app.post("/api/cashfree/create_order", async (req, res) => {
  try {
    const { amountInPaise, redirectUrl, name, email, phone, courseId } = req.body;

    if (!amountInPaise || !redirectUrl || !name || !email || !phone || !courseId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // NOTE: Cashfree takes amount in RUPEES, but your DB/Frontend sends PAISE.
    const amountInRupees = amountInPaise / 100;

    const merchantOrderId = `ORD-${randomUUID().slice(0, 12)}`; // Cashfree allows shorter IDs
    const customerId = `CUST-${randomUUID().slice(0, 12)}`;

    // 1. Store in DB as Pending
    await createPendingOrder({
      merchantOrderId,
      userName: name,
      email,
      phone,
      courseId,
      amountPaise: amountInPaise
    });

    // 2. Prepare Cashfree Request
    const request = {
      order_amount: amountInRupees,
      order_currency: "INR",
      order_id: merchantOrderId,
      customer_details: {
        customer_id: customerId,
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
      },
      order_meta: {
        return_url: `${redirectUrl}?order_id=${merchantOrderId}`,
        notify_url: `https://your-domain.com/api/cashfree/webhook` // Optional: explicitly set webhook url if not in dashboard
      },
      order_note: courseId // Store course ID in note
    };

    // 3. Call Cashfree API
    const response = await Cashfree.PGCreateOrder("2023-08-01", request);
    const data = response.data;

    // Cashfree returns a 'payment_session_id'. The frontend needs this to launch the SDK.
    return res.json({
      success: true,
      payment_session_id: data.payment_session_id,
      order_id: data.order_id,
    });

  } catch (err) {
    console.error("Create Order Error:", err.response?.data?.message || err.message);
    return res.status(500).json({ 
      success: false, 
      error: err.response?.data?.message || "Failed to create order" 
    });
  }
});

/* ----------------------------------------
   2) Get Order Status (Polling)
----------------------------------------- */
app.get("/api/cashfree/order_status/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const response = await Cashfree.PGFetchOrder("2023-08-01", orderId);
    
    // Cashfree status: PAID, ACTIVE, EXPIRED
    return res.json({ 
      success: true, 
      status: response.data.order_status,
      data: response.data 
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ----------------------------------------
   3) Webhook
----------------------------------------- */
app.post("/api/cashfree/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    const rawBody = req.rawBody;

    // 1. Verify Signature
    try {
        Cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
    } catch (err) {
        console.error("Webhook Signature Verification Failed");
        return res.status(400).send("Invalid Signature");
    }

    // 2. Parse Body
    const payload = req.body;
    console.log("WEBHOOK PAYLOAD:", JSON.stringify(payload, null, 2));

    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
        const orderId = payload.data.order.order_id;
        const transactionTime = payload.data.payment.payment_time || new Date().toISOString();
        const paymentStatus = payload.data.payment.payment_status; // "SUCCESS"

        // Map Cashfree status to DB status
        // Cashfree usually sends "SUCCESS" in webhook for payment success
        const dbStatus = paymentStatus === "SUCCESS" ? "SUCCESS" : "FAILED";

        await updateOrderStatus({
            merchantOrderId: orderId,
            transactionTime,
            status: dbStatus,
        });
    } else if (payload.type === "PAYMENT_FAILED_WEBHOOK") {
        const orderId = payload.data.order.order_id;
        await updateOrderStatus({
            merchantOrderId: orderId,
            transactionTime: new Date().toISOString(),
            status: "FAILED",
        });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

/* ----------------------------------------
   4) Get Order Details (For Frontend Success Page)
----------------------------------------- */
app.get("/api/order/:merchantOrderId", async (req, res) => {
  try {
    const order = await getOrderByMerchantId(req.params.merchantOrderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    res.json({
      order_number: order.order_number,
      merchant_order_id: order.merchant_order_id,
      amount: (order.amount_paise / 100).toFixed(2),
      name: order.user_name || "Not provided",
      email: order.email || "Not provided",
      phone: order.phone_number || "Not provided",
      date: order.transaction_date ? new Date(order.transaction_date).toLocaleDateString('en-IN') : 'N/A',
      status: order.status, 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------------------
   Health Check
----------------------------------------- */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    provider: "Cashfree",
    env: CASHFREE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/* ----------------------------------------
   Start Server
----------------------------------------- */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
