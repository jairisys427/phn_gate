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

// This schema is correct for future/new databases.
// The ALTER command was needed to update your existing one.
(async () => {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number      TEXT    UNIQUE,
        merchant_order_id TEXT    NOT NULL UNIQUE,
        transaction_date  TEXT,
        phone_number      TEXT,
        email             TEXT,
        user_name         TEXT,    -- This column is now in your DB
        course_id         TEXT,    -- This column is now in your DB
        amount_paise      INTEGER NOT NULL,
        status            TEXT    NOT NULL CHECK(status IN ('SUCCESS','FAILED','PENDING')),
        created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    console.log("Table `orders` ready");
  } catch (err) {
    console.error("Failed to create orders table:", err);
    process.exit(1);
  }
})();

// Helper to generate a unique order number for successful transactions
function generateOrderNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${datePart}-${rand}`;
}

// 1. Create a PENDING order when payment is initiated
export async function createPendingOrder({
  merchantOrderId,
  userName,
  email,
  phone,
  courseId,
  amountPaise,
}) {
  try {
    const sql = `
      INSERT INTO orders (merchant_order_id, user_name, email, phone_number, course_id, amount_paise, status)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
      ON CONFLICT(merchant_order_id) DO NOTHING
    `;
    const args = [merchantOrderId, userName, email, phone, courseId, amountPaise];
    const result = await db.execute({ sql, args });
    console.log(`DB PENDING: ${merchantOrderId} | User: ${userName} | Rows affected: ${result.rowsAffected}`);
    return result;
  } catch (err) {
    console.error("DB PENDING FAILED:", err);
    throw err; // Re-throw to be caught by the API route
  }
}


// 2. Update order status from webhook
export async function updateOrderStatus({
  merchantOrderId,
  transactionTime,
  status, // 'SUCCESS' or 'FAILED'
}) {
  try {
    console.log(`DB UPDATE: ${merchantOrderId} | Status: ${status}`);

    const isSuccess = status === "SUCCESS";
    const orderNumber = isSuccess ? generateOrderNumber() : null;

    const sql = isSuccess
      ? `
        UPDATE orders SET
          status = ?,
          order_number = ?,
          transaction_date = ?
        WHERE merchant_order_id = ? AND status = 'PENDING'
      `
      : `
        UPDATE orders SET
          status = ?,
          transaction_date = ?
        WHERE merchant_order_id = ? AND status = 'PENDING'
      `;
      
    const args = isSuccess
      ? [status, orderNumber, transactionTime, merchantOrderId]
      : [status, transactionTime, merchantOrderId];

    const result = await db.execute({ sql, args });
    console.log(`DB UPDATE SUCCESS: Affected rows: ${result.rowsAffected} | Order#: ${orderNumber || 'N/A'}`);
  } catch (err)
 {
    console.error("DB UPDATE FAILED:", err.message || err);
    // Don't throw - webhook must return 200 OK
  }
}

// Get order by merchant order ID (no changes needed)
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
