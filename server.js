// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { randomUUID, createHmac } from "crypto";
import axios from "axios";

import {
  createPendingOrder,
  updateOrderStatus,
  getOrderByMerchantId,
} from "./db.js";

dotenv.config();

/* ----------------------------------------
   Helpers
----------------------------------------- */
const trim = (v) => (typeof v === "string" ? v.trim() : v);

/* ----------------------------------------
   Load & Validate ENV
----------------------------------------- */
const APP_ID = trim(process.env.CASHFREE_APP_ID || "");
const SECRET_KEY = trim(process.env.CASHFREE_SECRET_KEY || "");
const CASHFREE_ENV = trim(process.env.CASHFREE_ENV || "SANDBOX").toUpperCase();

if (!APP_ID || !SECRET_KEY) {
  console.error("❌ Missing Cashfree credentials");
  process.exit(1);
}

const CASHFREE_BASE_URL =
  CASHFREE_ENV === "PRODUCTION"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";

const API_VERSION = "2023-08-01";

console.log(`✅ Cashfree ENV: ${CASHFREE_ENV}`);
console.log(`🔗 Cashfree URL: ${CASHFREE_BASE_URL}`);

/* ----------------------------------------
   Express App
----------------------------------------- */
const app = express();

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
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((o) => o.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-webhook-signature, x-webhook-timestamp"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 5000;

/* ----------------------------------------
   1️⃣ CREATE ORDER
----------------------------------------- */
app.post("/api/cashfree/create_order", async (req, res) => {
  try {
    const { amountInPaise, redirectUrl, name, email, phone, courseId } =
      req.body;

    if (!amountInPaise || !redirectUrl || !name || !email || !phone || !courseId) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const amountInRupees = (amountInPaise / 100).toFixed(2);
    const merchantOrderId = `ORD-${randomUUID().slice(0, 12)}`;
    const customerId = `CUST-${randomUUID().slice(0, 12)}`;

    await createPendingOrder({
      merchantOrderId,
      userName: name,
      email,
      phone,
      courseId,
      amountPaise: amountInPaise,
    });

    const orderRequest = {
      order_id: merchantOrderId,
      order_amount: Number(amountInRupees),
      order_currency: "INR",
      customer_details: {
        customer_id: customerId,
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
      },
      order_meta: {
        return_url: `${redirectUrl}?order_id=${merchantOrderId}`,
      },
      order_note: courseId,
    };

    const response = await axios.post(
      `${CASHFREE_BASE_URL}/pg/orders`,
      orderRequest,
      {
        headers: {
          "x-api-version": API_VERSION,
          "x-client-id": APP_ID,
          "x-client-secret": SECRET_KEY,
        },
      }
    );

    return res.json({
      success: true,
      order_id: merchantOrderId,
      payment_session_id: response.data.payment_session_id,
    });
  } catch (err) {
    console.error("❌ Create Order Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Order creation failed" });
  }
});

/* ----------------------------------------
   2️⃣ WEBHOOK (SOURCE OF TRUTH)
----------------------------------------- */
app.post("/api/cashfree/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];

    if (!signature || !timestamp) return res.sendStatus(400);

    const computed = createHmac("sha256", SECRET_KEY)
      .update(timestamp + req.rawBody)
      .digest("base64");

    if (computed !== signature) return res.sendStatus(400);

    const payload = req.body;
    const orderId = payload?.data?.order?.order_id;

    if (!orderId) return res.sendStatus(200);

    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
      await updateOrderStatus({
        merchantOrderId: orderId,
        transactionTime:
          payload.data.payment.payment_time || new Date().toISOString(),
        status: "SUCCESS",
      });
    }

    if (payload.type === "PAYMENT_FAILED_WEBHOOK") {
      await updateOrderStatus({
        merchantOrderId: orderId,
        transactionTime: new Date().toISOString(),
        status: "FAILED",
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    return res.sendStatus(200);
  }
});

/* ----------------------------------------
   3️⃣ CHECK PAYMENT STATUS (DB ONLY)
----------------------------------------- */
app.get("/api/order/:merchantOrderId", async (req, res) => {
  try {
    const order = await getOrderByMerchantId(req.params.merchantOrderId);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    return res.json({
      success: true,
      order: {
        merchant_order_id: order.merchant_order_id,
        status: order.status, // SUCCESS | FAILED | PENDING
        amount: (order.amount_paise / 100).toFixed(2),
        name: order.user_name,
        email: order.email,
        phone: order.phone_number,
        course_id: order.course_id,
        created_at: order.created_at,
      },
    });
  } catch (err) {
    console.error("❌ DB STATUS ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* ----------------------------------------
   Health Check
----------------------------------------- */
app.get("/health", (_, res) => {
  res.json({
    status: "OK",
    env: CASHFREE_ENV,
    time: new Date().toISOString(),
  });
});

/* ----------------------------------------
   Start Server
----------------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
