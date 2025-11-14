// db.js
import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const trim = (v) => (typeof v === "string" ? v.trim() : v);

const TURSO_DATABASE_URL = trim(process.env.TURSO_DATABASE_URL || "");
const TURSO_AUTH_TOKEN   = trim(process.env.TURSO_AUTH_TOKEN   || "");

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
        order_number      TEXT    NOT NULL UNIQUE,
        merchant_order_id TEXT    NOT NULL UNIQUE,
        transaction_date  TEXT    NOT NULL,
        phone_number      TEXT,
        email             TEXT,
        amount_paise      INTEGER NOT NULL,
        status            TEXT    NOT NULL CHECK(status IN ('SUCCESS','FAILED')),
        created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    console.log("Table `orders` is ready");
  } catch (err) {
    console.error("Failed to create orders table:", err);
    process.exit(1);
  }
})();

// Generate human-readable order number: ORD-YYYYMMDD-XXXXXX
export function generateOrderNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const rand = Math.floor(100000 + Math.random() * 900000);         // 6-digit
  return `ORD-${datePart}-${rand}`;
}

// Save or update order (idempotent)
export async function saveOrder({
  merchantOrderId,
  transactionTime,
  phone,
  email,
  amountPaise,
  status,
  orderNumber = null,
}) {
  try {
    if (status === "SUCCESS" && !orderNumber) {
      orderNumber = generateOrderNumber();
    }

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
          phone_number   = excluded.phone_number,
          email          = excluded.email,
          amount_paise   = excluded.amount_paise,
          status         = excluded.status
      `;

    const args = status === "SUCCESS"
      ? [orderNumber, merchantOrderId, transactionTime, phone, email, amountPaise, status]
      : [merchantOrderId, transactionTime, phone, email, amountPaise, status];

    await db.execute({ sql, args });
    console.log(`Order ${orderNumber || '(no number)'} saved/updated for ${merchantOrderId}`);
  } catch (err) {
    console.error("DB save failed:", err);
    // Do not throw — webhook must respond 200
  }
}

// Optional: fetch order by merchantOrderId
export async function getOrderByMerchantId(merchantOrderId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM orders WHERE merchant_order_id = ?",
    args: [merchantOrderId],
  });
  return rows[0] || null;
}

export default db;