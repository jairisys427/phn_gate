// db.js
import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const trim = (v) => (typeof v === "string" ? v.trim() : v);

const TURSO_DATABASE_URL = trim(process.env.TURSO_DATABASE_URL || "");
const TURSO_AUTH_TOKEN = trim(process.env.TURSO_AUTH_TOKEN || "");

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error("Missing Turso credentials in .env");
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

// Create table on module load
(async () => {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number      TEXT    UNIQUE,
        merchant_order_id TEXT    NOT NULL UNIQUE,
        transaction_date  TEXT    NOT NULL,
        phone_number      TEXT,
        email             TEXT,
        amount_paise      INTEGER NOT NULL,
        status            TEXT    NOT NULL CHECK(status IN ('SUCCESS','FAILED')),
        created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    console.log("Table `orders` ready");
  } catch (err) {
    console.error("Failed to create orders table:", err);
    process.exit(1);
  }
})();

// Generate order number
export function generateOrderNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${datePart}-${rand}`;
}

// Save order with logging
export async function saveOrder({
  merchantOrderId,
  transactionTime,
  phone,
  email,
  amountPaise,
  status,
}) {
  try {
    console.log(`DB SAVE: ${merchantOrderId} | ${status} | ₹${amountPaise/100} | ${email} | ${phone}`);

    const orderNumber = status === "SUCCESS" ? generateOrderNumber() : null;

    const sql = status === "SUCCESS"
      ? `
        INSERT INTO orders (order_number, merchant_order_id, transaction_date,
                            phone_number, email, amount_paise, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(merchant_order_id) DO UPDATE SET
          order_number   = excluded.order_number,
          transaction_date = excluded.transaction_date,
          phone_number   = excluded.phone_number,
          email          = excluded.email,
          amount_paise   = excluded.amount_paise,
          status         = excluded.status
      `
      : `
        INSERT INTO orders (merchant_order_id, transaction_date,
                            phone_number, email, amount_paise, status)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(merchant_order_id) DO UPDATE SET
          transaction_date = excluded.transaction_date,
          phone_number     = excluded.phone_number,
          email            = excluded.email,
          amount_paise     = excluded.amount_paise,
          status           = excluded.status
      `;

    const args = status === "SUCCESS"
      ? [orderNumber, merchantOrderId, transactionTime, phone, email, amountPaise, status]
      : [merchantOrderId, transactionTime, phone, email, amountPaise, status];

    const result = await db.execute({ sql, args });
    console.log(`DB SAVE SUCCESS: Affected rows: ${result.rowsAffected} | Order#: ${orderNumber || 'N/A'}`);
  } catch (err) {
    console.error("DB SAVE FAILED:", err.message || err);
    console.error("Full error:", err);
    // Don't throw - webhook must 200
  }
}

// Get order
export async function getOrderByMerchantId(merchantOrderId) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM orders WHERE merchant_order_id = ?",
      args: [merchantOrderId],
    });
    return rows[0] || null;
  } catch (err) {
    console.error("DB GET FAILED:", err);
    throw err;
  }
}

export default db;
