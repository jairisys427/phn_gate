// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { randomUUID, createHmac } from "crypto";
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
  console.error("❌ Missing Cashfree config (APP_ID or SECRET_KEY) in .env");
  process.exit(1);
}

/* ----------------------------------------
   Initialize Cashfree SDK
----------------------------------------- */
Cashfree.XClientId = APP_ID;
Cashfree.XClientSecret = SECRET_KEY;
Cashfree.XEnvironment = CASHFREE_ENV === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";

console.log(`✅ Cashfree SDK initialized in ${Cashfree.XEnvironment} mode`);

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

    // Validation
    if (!amountInPaise || !redirectUrl || !name || !email || !phone || !courseId) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields",
        required: ["amountInPaise", "redirectUrl", "name", "email", "phone", "courseId"]
      });
    }

    // Validate amount
    if (isNaN(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    // CONVERSION: Frontend sends Paise, Cashfree needs Rupees
    const amountInRupees = (amountInPaise / 100).toFixed(2);

    // Generate IDs
    const merchantOrderId = `ORD-${randomUUID().slice(0, 12)}`; 
    const customerId = `CUST-${randomUUID().slice(0, 12)}`;

    console.log(`📝 Creating order: ${merchantOrderId} | Amount: ₹${amountInRupees} | User: ${name}`);

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
      order_amount: parseFloat(amountInRupees),
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

    console.log(`✅ Order created: ${data.order_id}`);

    return res.json({
      success: true,
      payment_session_id: data.payment_session_id,
      order_id: data.order_id,
      cf_order_id: data.cf_order_id
    });

  } catch (err) {
    console.error("❌ Create Order Error:", err.response?.data || err.message);
    return res.status(500).json({ 
      success: false, 
      message: err.response?.data?.message || "Failed to create order",
      error: err.message
    });
  }
});

/* ----------------------------------------
   2) Get Order Status (For polling & verification)
----------------------------------------- */
app.get("/api/cashfree/order_status/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    console.log(`🔍 Checking status for order: ${orderId}`);
    
    // Get from Cashfree
    const response = await Cashfree.PGFetchOrder("2023-08-01", orderId);
    const cfStatus = response.data.order_status;
    
    // Also get from our DB
    const dbOrder = await getOrderByMerchantId(orderId);
    
    return res.json({ 
      success: true, 
      order_id: orderId,
      cashfree_status: cfStatus,
      db_status: dbOrder?.status || 'NOT_FOUND',
      order_data: response.data,
      db_order: dbOrder
    });
  } catch (err) {
    console.error("❌ Order Status Error:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to fetch order status",
      error: err.message 
    });
  }
});

/* ----------------------------------------
   3) Webhook (Manual Verification)
----------------------------------------- */
app.post("/api/cashfree/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    const rawBody = req.rawBody;

    console.log(`🔔 Webhook received at ${new Date().toISOString()}`);

    if (!signature || !timestamp || !rawBody) {
      console.error("❌ Missing webhook headers");
      return res.status(400).send("Missing headers");
    }

    // --- MANUAL SIGNATURE VERIFICATION ---
    try {
      const data = timestamp + rawBody;
      const generatedSignature = createHmac('sha256', SECRET_KEY)
        .update(data)
        .digest('base64');

      if (generatedSignature !== signature) {
        console.error("❌ Webhook Signature Mismatch");
        console.error("Expected:", generatedSignature);
        console.error("Received:", signature);
        return res.status(400).send("Invalid Signature");
      }
      console.log("✅ Webhook signature verified");
    } catch (verifyError) {
      console.error("❌ Verification Error:", verifyError);
      return res.status(400).send("Verification Failed");
    }

    // 4. Process Payload
    const payload = req.body;
    console.log(`📦 Webhook Type: ${payload.type}`);

    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
      const orderId = payload.data.order.order_id;
      const transactionTime = payload.data.payment.payment_time || new Date().toISOString();
      const paymentStatus = payload.data.payment.payment_status;
      const paymentAmount = payload.data.payment.payment_amount;

      console.log(`💰 Payment Success: ${orderId} | Amount: ₹${paymentAmount}`);

      const dbStatus = paymentStatus === "SUCCESS" ? "SUCCESS" : "FAILED";

      await updateOrderStatus({
        merchantOrderId: orderId,
        transactionTime,
        status: dbStatus,
      });
      
      console.log(`✅ Order ${orderId} updated to ${dbStatus}`);
    } 
    else if (payload.type === "PAYMENT_FAILED_WEBHOOK") {
      const orderId = payload.data.order.order_id;
      console.log(`❌ Payment Failed: ${orderId}`);
      
      await updateOrderStatus({
        merchantOrderId: orderId,
        transactionTime: new Date().toISOString(),
        status: "FAILED",
      });
      
      console.log(`✅ Order ${orderId} marked as FAILED`);
    }
    else if (payload.type === "PAYMENT_USER_DROPPED_WEBHOOK") {
      const orderId = payload.data.order.order_id;
      console.log(`⚠️ Payment Dropped: ${orderId}`);
      // Keep as PENDING - user may retry
    }

    return res.status(200).json({ success: true });
    
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    // Always return 200 to prevent Cashfree retries
    return res.status(200).send("OK"); 
  }
});

/* ----------------------------------------
   4) Get Order Details (For frontend verification)
----------------------------------------- */
app.get("/api/order/:merchantOrderId", async (req, res) => {
  try {
    const order = await getOrderByMerchantId(req.params.merchantOrderId);
    
    if (!order) {
      return res.status(404).json({ 
        success: false,
        error: "Order not found" 
      });
    }

    res.json({
      success: true,
      order: {
        order_number: order.order_number,
        merchant_order_id: order.merchant_order_id,
        amount: (order.amount_paise / 100).toFixed(2),
        currency: "INR",
        name: order.user_name || "Not provided",
        email: order.email || "Not provided",
        phone: order.phone_number || "Not provided",
        course_id: order.course_id,
        date: order.transaction_date 
          ? new Date(order.transaction_date).toLocaleDateString('en-IN') 
          : 'Pending',
        status: order.status,
        created_at: order.created_at
      }
    });
  } catch (err) {
    console.error("❌ Get Order Error:", err);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

/* ----------------------------------------
   5) Verify Payment (For frontend to double-check)
----------------------------------------- */
app.post("/api/cashfree/verify_payment", async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ 
        success: false, 
        message: "Order ID required" 
      });
    }

    // Get from Cashfree
    const cfResponse = await Cashfree.PGFetchOrder("2023-08-01", orderId);
    const cfStatus = cfResponse.data.order_status;
    
    // Get from DB
    const dbOrder = await getOrderByMerchantId(orderId);
    
    // If Cashfree says success but DB is still pending, update DB
    if (cfStatus === "PAID" && dbOrder?.status === "PENDING") {
      console.log(`⚠️ Sync issue detected for ${orderId}, updating DB...`);
      await updateOrderStatus({
        merchantOrderId: orderId,
        transactionTime: cfResponse.data.order_tags?.payment_time || new Date().toISOString(),
        status: "SUCCESS",
      });
    }

    return res.json({
      success: true,
      verified: cfStatus === "PAID",
      cashfree_status: cfStatus,
      db_status: dbOrder?.status,
      order: dbOrder
    });

  } catch (err) {
    console.error("❌ Verify Payment Error:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Verification failed",
      error: err.message 
    });
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
    endpoints: {
      create_order: "/api/cashfree/create_order",
      order_status: "/api/cashfree/order_status/:orderId",
      verify_payment: "/api/cashfree/verify_payment",
      webhook: "/api/cashfree/webhook",
      get_order: "/api/order/:merchantOrderId"
    }
  });
});

/* ----------------------------------------
   Error Handler
----------------------------------------- */
app.use((err, req, res, next) => {
  console.error("💥 Unhandled Error:", err);
  res.status(500).json({ 
    success: false, 
    message: "Internal server error" 
  });
});

/* ----------------------------------------
   Start Server
----------------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${Cashfree.XEnvironment}`);
  console.log(`📡 Allowed Origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
