// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { Cashfree } from "cashfree-pg"; 

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
   Initialize Cashfree SDK (FIXED)
----------------------------------------- */
Cashfree.XClientId = APP_ID;
Cashfree.XClientSecret = SECRET_KEY;

// FIX: Use simple strings instead of Cashfree.Environment.SANDBOX which was undefined
Cashfree.XEnvironment = CASHFREE_ENV === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";

console.log(`Initializing Cashfree SDK in ${Cashfree.XEnvironment} mode`);

/* ----------------------------------------
   Express App
----------------------------------------- */
const app = express();

// Middleware: Capture raw body for Webhook Verification
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-webhook-signature, x-webhook-timestamp");
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

    // CONVERSION: PhonePe sends Paise, Cashfree needs Rupees
    const amountInRupees = amountInPaise / 100;

    // Generate IDs
    const merchantOrderId = `ORD-${randomUUID().slice(0, 12)}`; 
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
    // Note: '2023-08-01' is the API version required by the SDK
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
      },
      order_note: courseId 
    };

    // 3. Call Cashfree API
    const response = await Cashfree.PGCreateOrder("2023-08-01", request);
    const data = response.data;

    // Return the payment_session_id to frontend
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
    
    return res.json({ 
      success: true, 
      status: response.data.order_status, // "PAID", "ACTIVE", "EXPIRED"
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
    const rawBody = req.rawBody; // Captured by body-parser verify

    if (!signature || !timestamp || !rawBody) {
        return res.status(400).send("Missing headers");
    }

    // 1. Verify Signature
    try {
        Cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
    } catch (err) {
        console.error("Webhook Signature Verification Failed:", err.message);
        return res.status(400).send("Invalid Signature");
    }

    // 2. Process Payload
    const payload = req.body;
    console.log("WEBHOOK RECEIVED:", payload.type);

    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
        const orderId = payload.data.order.order_id;
        const transactionTime = payload.data.payment.payment_time || new Date().toISOString();
        const paymentStatus = payload.data.payment.payment_status; // usually "SUCCESS"

        const dbStatus = paymentStatus === "SUCCESS" ? "SUCCESS" : "FAILED";

        await updateOrderStatus({
            merchantOrderId: orderId,
            transactionTime,
            status: dbStatus,
        });
        console.log(`Order ${orderId} updated to ${dbStatus}`);
    } 
    else if (payload.type === "PAYMENT_FAILED_WEBHOOK") {
        const orderId = payload.data.order.order_id;
        await updateOrderStatus({
            merchantOrderId: orderId,
            transactionTime: new Date().toISOString(),
            status: "FAILED",
        });
        console.log(`Order ${orderId} updated to FAILED`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    // Always return 200 to Cashfree otherwise they will retry
    return res.status(200).send("OK"); 
  }
});

/* ----------------------------------------
   4) Get Order Details (Frontend Success Page)
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
    env: Cashfree.XEnvironment,
    timestamp: new Date().toISOString(),
  });
});

/* ----------------------------------------
   Start Server
----------------------------------------- */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Environment: ${Cashfree.XEnvironment}`);
});
