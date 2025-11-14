// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import {
  StandardCheckoutClient,
  Env,
  MetaInfo,
  StandardCheckoutPayRequest,
  CreateSdkOrderRequest,
  RefundRequest,
} from "pg-sdk-node";

import { saveOrder, getOrderByMerchantId } from "./db.js";

dotenv.config();

/* ----------------------------------------
   Helpers
----------------------------------------- */
const trim = (v) => (typeof v === "string" ? v.trim() : v);
const mask = (s, keep = 4) => {
  if (!s) return "";
  if (s.length <= keep * 2) return "*".repeat(s.length);
  return s.slice(0, keep) + "*".repeat(Math.max(6, s.length - keep * 2)) + s.slice(-keep);
};

/* ----------------------------------------
   Load and validate env
----------------------------------------- */
const MERCHANT_ID = trim(process.env.MERCHANT_ID || "");
const SALT_KEY = trim(process.env.PHONEPE_SALT_KEY || "");
const SALT_INDEX_RAW = trim(process.env.PHONEPE_SALT_INDEX || "");
const SALT_INDEX = SALT_INDEX_RAW === "" ? NaN : parseInt(SALT_INDEX_RAW, 10);
const PHONEPE_ENV =
  (trim(process.env.PHONEPE_ENV || "SANDBOX").toUpperCase() === "PRODUCTION"
    ? Env.PRODUCTION
    : Env.SANDBOX);

if (!MERCHANT_ID || !SALT_KEY || Number.isNaN(SALT_INDEX)) {
  console.error("Missing/invalid PhonePe config in .env");
  process.exit(1);
}

/* ----------------------------------------
   Initialize PhonePe SDK
----------------------------------------- */
let phonepeClient;
try {
  console.log(
    `Initializing PhonePe SDK (merchant=${mask(MERCHANT_ID)}, env=${PHONEPE_ENV === Env.PRODUCTION ? "PRODUCTION" : "SANDBOX"})`
  );
  phonepeClient = StandardCheckoutClient.getInstance(
    MERCHANT_ID,
    SALT_KEY,
    SALT_INDEX,
    PHONEPE_ENV
  );
} catch (err) {
  console.error("PhonePe SDK init failed:", err?.message);
  process.exit(1);
}

/* ----------------------------------------
   Express App
----------------------------------------- */
const app = express();
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
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
   1) Pay (Web)
----------------------------------------- */
app.post("/api/phonepe/pay", async (req, res) => {
  try {
    const { amountInPaise, redirectUrl, meta } = req.body;

    if (!amountInPaise || amountInPaise < 100) {
      return res.status(400).json({ success: false, message: "Amount >= 100 paise" });
    }
    if (!redirectUrl) {
      return res.status(400).json({ success: false, message: "redirectUrl required" });
    }

    const merchantOrderId = `MUID-${randomUUID().slice(0, 16)}`;

    let metaInfo = undefined;
    if (meta) {
      const builder = MetaInfo.builder();
      if (meta.udf1) builder.udf1(meta.udf1); // phone
      if (meta.udf2) builder.udf2(meta.udf2); // email
      if (meta.udf3) builder.udf3(meta.udf3);
      metaInfo = builder.build();
    }

    const request = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantOrderId)
      .amount(amountInPaise)
      .redirectUrl(redirectUrl)
      .metaInfo(metaInfo)
      .build();

    const response = await phonepeClient.pay(request);

    if (response.redirectUrl) {
      return res.json({
        success: true,
        merchantOrderId,
        redirectUrl: response.redirectUrl,
      });
    } else {
      return res.status(403).json({
        success: false,
        error: "Account not activated",
        onboardingUrl: response.data?.Onboarding_URL?.[0] || null,
      });
    }
  } catch (err) {
    console.error("Pay error:", err);
    return res.status(500).json({ success: false, error: err?.message || "Failed" });
  }
});

/* ----------------------------------------
   2) SDK Order (Mobile)
----------------------------------------- */
app.post("/api/phonepe/create_sdk_order", async (req, res) => {
  try {
    const { amountInPaise, redirectUrl } = req.body;
    if (!amountInPaise || amountInPaise < 100 || !redirectUrl) {
      return res.status(400).json({ success: false, message: "Invalid input" });
    }

    const merchantOrderId = `MUID-${randomUUID().slice(0, 16)}`;
    const request = CreateSdkOrderRequest.StandardCheckoutBuilder()
      .merchantOrderId(merchantOrderId)
      .amount(amountInPaise)
      .redirectUrl(redirectUrl)
      .build();

    const response = await phonepeClient.createSdkOrder(request);
    return res.json({ success: true, merchantOrderId, token: response.token });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ----------------------------------------
   3) Order Status
----------------------------------------- */
app.get("/api/phonepe/order_status/:merchantOrderId", async (req, res) => {
  try {
    const response = await phonepeClient.getOrderStatus(req.params.merchantOrderId);
    return res.json({ success: true, data: response });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ----------------------------------------
   4) Refund
----------------------------------------- */
app.post("/api/phonepe/refund", async (req, res) => {
  try {
    const { originalMerchantOrderId, amountInPaise } = req.body;
    if (!originalMerchantOrderId || !amountInPaise) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const merchantRefundId = `MRID-${randomUUID().slice(0, 16)}`;
    const request = RefundRequest.builder()
      .amount(amountInPaise)
      .merchantRefundId(merchantRefundId)
      .originalMerchantOrderId(originalMerchantOrderId)
      .build();

    const response = await phonepeClient.refund(request);
    return res.json({ success: true, merchantRefundId, data: response });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ----------------------------------------
   5) Webhook – Save to DB on success
----------------------------------------- */
app.post("/api/phonepe/webhook", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const bodyString = req.rawBody?.toString("utf8") || "";

    const callbackUser = process.env.CALLBACK_USERNAME;
    const callbackPass = process.env.CALLBACK_PASSWORD;

    if (!callbackUser || !callbackPass) {
      return res.status(500).send("Webhook auth missing");
    }

    const callbackResponse = phonepeClient.validateCallback(
      callbackUser,
      callbackPass,
      authHeader,
      bodyString
    );

    const payload = callbackResponse.payload;
    console.log("WEBHOOK PAYLOAD:", JSON.stringify(payload, null, 2));

    const merchantOrderId = payload.merchantOrderId;
    const paymentState    = payload.paymentState;
    const amountPaise     = payload.amount;
    const transactionTime = payload.transactionTime;

    const phone = payload?.meta?.udf1 ?? null;
    const email = payload?.meta?.udf2 ?? null;

    const isSuccess = paymentState === "COMPLETED";
    const status = isSuccess ? "SUCCESS" : "FAILED";

    await saveOrder({
      merchantOrderId,
      transactionTime,
      phone,
      email,
      amountPaise,
      status,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Webhook failed:", err?.message);
    return res.status(403).send("Invalid");
  }
});

/* ----------------------------------------
   6) Get Order (Optional)
----------------------------------------- */
// server.js – inside the /api/order route
app.get("/api/order/:merchantOrderId", async (req, res) => {
  try {
    const order = await getOrderByMerchantId(req.params.merchantOrderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Send clean, front-end-ready fields
    res.json({
      order_number: order.order_number,
      merchant_order_id: order.merchant_order_id,
      amount: (order.amount_paise / 100).toFixed(2),
      email: order.email || "Not provided",
      phone: order.phone_number || "Not provided",
      date: new Date(order.transaction_date).toLocaleDateString('en-IN'),
      transaction_id: order.merchant_order_id, // fallback
      status: order.status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------------------
   7) Health
----------------------------------------- */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    env: PHONEPE_ENV === Env.PRODUCTION ? "PRODUCTION" : "SANDBOX",
    merchantId: mask(MERCHANT_ID),
    timestamp: new Date().toISOString(),
  });
});

/* ----------------------------------------
   Start Server
----------------------------------------- */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Environment: ${PHONEPE_ENV === Env.PRODUCTION ? "PRODUCTION" : "SANDBOX"}`);
});
