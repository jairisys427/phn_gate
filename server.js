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

dotenv.config();

/* ----------------------------------------
   Helpers: trim, mask
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
  console.error("Missing/invalid PhonePe config in .env. Values read:", {
    MERCHANT_ID: MERCHANT_ID ? mask(MERCHANT_ID) : "<missing>",
    PHONEPE_SALT_KEY: SALT_KEY ? mask(SALT_KEY, 6) : "<missing>",
    PHONEPE_SALT_INDEX: SALT_INDEX_RAW || "<missing>",
    PHONEPE_ENV: process.env.PHONEPE_ENV || "<missing>",
  });
  process.exit(1);
}

/* ----------------------------------------
   Initialize PhonePe SDK (only once)
----------------------------------------- */
let phonepeClient;
try {
  console.log(
    `Initializing PhonePe SDK (merchant=${mask(MERCHANT_ID)}, saltIndex=${SALT_INDEX}, env=${PHONEPE_ENV === Env.PRODUCTION ? "PRODUCTION" : "SANDBOX"})`
  );
  phonepeClient = StandardCheckoutClient.getInstance(
    MERCHANT_ID,
    SALT_KEY,
    SALT_INDEX,
    PHONEPE_ENV
  );
} catch (err) {
  console.error("PhonePe SDK initialization failed:", err?.message || err);
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
   CORS middleware
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const PORT = process.env.PORT || 5000;

/* ----------------------------------------
   1) Standard Checkout Payment (Web)
----------------------------------------- */
app.post("/api/phonepe/pay", async (req, res) => {
  try {
    const { amountInPaise, redirectUrl, meta } = req.body;

    if (!amountInPaise || amountInPaise < 100) {
      return res.status(400).json({ success: false, message: "Amount must be >= 100 paisa" });
    }
    if (!redirectUrl) {
      return res.status(400).json({ success: false, message: "redirectUrl is required" });
    }

    const merchantOrderId = `MUID-${randomUUID().slice(0, 16)}`;

    let metaInfo = undefined;
    if (meta) {
      const builder = MetaInfo.builder();
      if (meta.udf1) builder.udf1(meta.udf1);
      if (meta.udf2) builder.udf2(meta.udf2);
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
      // Handle onboarding block
      return res.status(403).json({
        success: false,
        error: "Account not activated",
        errorCode: "INTERNAL_SECURITY_BLOCK_1",
        onboardingUrl: response.data?.Onboarding_URL?.[0] || null,
        message: "Complete onboarding at the provided URL",
      });
    }
  } catch (err) {
    console.error("Payment initiation failed:", {
      message: err?.message,
      type: err?.type,
      code: err?.code,
      httpStatusCode: err?.httpStatusCode,
      data: err?.data,
    });

    // Handle specific PhonePe errors
    if (err?.httpStatusCode === 400 && err?.data?.errorCode === "INTERNAL_SECURITY_BLOCK_1") {
      return res.status(403).json({
        success: false,
        error: "Account not activated for transactions",
        errorCode: "INTERNAL_SECURITY_BLOCK_1",
        onboardingUrl: err?.data?.Onboarding_URL?.[0] || null,
        message: "Please complete merchant onboarding on PhonePe dashboard",
      });
    }

    return res.status(500).json({
      success: false,
      error: err?.message || "Payment initiation failed",
    });
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
   5) Webhook
----------------------------------------- */
app.post("/api/phonepe/webhook", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const bodyString = req.rawBody?.toString("utf8") || "";

    const callbackUser = process.env.CALLBACK_USERNAME;
    const callbackPass = process.env.CALLBACK_PASSWORD;

    if (!callbackUser || !callbackPass) {
      return res.status(500).send("Webhook credentials not configured");
    }

    const callbackResponse = phonepeClient.validateCallback(
      callbackUser,
      callbackPass,
      authHeader,
      bodyString
    );

    console.log("PHONEPE WEBHOOK:", callbackResponse.type);
    console.log("Payload:", JSON.stringify(callbackResponse.payload, null, 2));

    // TODO: Update your DB with payment status
    // if (callbackResponse.payload.paymentState === "COMPLETED") { ... }

    return res.json({ success: true });
  } catch (err) {
    console.error("Webhook validation failed:", err?.message);
    return res.status(403).send("Invalid callback");
  }
});

/* ----------------------------------------
   6) Health Check
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
  console.log(`PhonePe backend LIVE on http://localhost:${PORT}`);
  console.log(`Environment: ${PHONEPE_ENV === Env.PRODUCTION ? "PRODUCTION" : "SANDBOX"}`);
  if (PHONEPE_ENV === Env.PRODUCTION) {
    console.log("Ensure your merchant account is ACTIVATED on PhonePe dashboard!");
  }
});