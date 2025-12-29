// db.js
import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const trim = (v) => (typeof v === "string" ? v.trim() : v);

const TURSO_DATABASE_URL = trim(process.env.TURSO_DATABASE_URL || "");
const TURSO_AUTH_TOKEN = trim(process.env.TURSO_AUTH_TOKEN || "");

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error("❌ Missing Turso credentials in .env");
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

/* ------------------------------------------------
   SCHEMA + SAFE MIGRATIONS
------------------------------------------------- */
(async () => {
  try {
    // 1️⃣ Create table if it does NOT exist (new DBs)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number      TEXT UNIQUE,
        merchant_order_id TEXT,
        transaction_date  TEXT,
        phone_number      TEXT,
        email             TEXT,
        user_name         TEXT,
        course_id         TEXT,
        amount_paise      INTEGER NOT NULL,
        status            TEXT NOT NULL CHECK(status IN ('SUCCESS','FAILED','PENDING')),
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // 2️⃣ Migrate OLD databases safely
    // SQLite doesn't support IF NOT EXISTS for ADD COLUMN
    const migrations = [
      `ALTER TABLE orders ADD COLUMN merchant_order_id TEXT`,
      `ALTER TABLE orders ADD COLUMN user_name TEXT`,
      `ALTER TABLE orders ADD COLUMN course_id TEXT`,
    ];

    for (const sql of migrations) {
      try {
        await db.execute(sql);
      } catch (_) {
        // Column already exists – safe to ignore
      }
    }

    // 3️⃣ Ensure UNIQUE constraint for merchant_order_id
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_merchant_order_id
      ON orders (merchant_order_id)
    `);

    console.log("✅ Table `orders` ready + migrations applied");
  } catch (err) {
    console.error("❌ Failed to initialize database:", err);
    process.exit(1);
  }
})();

/* ------------------------------------------------
   HELPERS
------------------------------------------------- */
function generateOrderNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${datePart}-${rand}`;
}

/* ------------------------------------------------
   1) CREATE PENDING ORDER
------------------------------------------------- */
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
      INSERT INTO orders (
        merchant_order_id,
        user_name,
        email,
        phone_number,
        course_id,
        amount_paise,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
      ON CONFLICT(merchant_order_id) DO NOTHING
    `;

    const args = [
      merchantOrderId,
      userName,
      email,
      phone,
      courseId,
      amountPaise,
    ];

    const result = await db.execute({ sql, args });

    console.log(
      `🟡 DB PENDING: ${merchantOrderId} | User: ${userName} | Rows: ${result.rowsAffected}`
    );

    return result;
  } catch (err) {
    console.error("❌ DB PENDING FAILED:", err);
    throw err;
  }
}

/* ------------------------------------------------
   2) UPDATE ORDER STATUS (Webhook / Verify)
------------------------------------------------- */
export async function updateOrderStatus({
  merchantOrderId,
  transactionTime,
  status, // SUCCESS | FAILED
}) {
  try {
    console.log(`🔄 DB UPDATE: ${merchantOrderId} → ${status}`);

    const isSuccess = status === "SUCCESS";
    const orderNumber = isSuccess ? generateOrderNumber() : null;

    const sql = isSuccess
      ? `
        UPDATE orders SET
          status = ?,
          order_number = ?,
          transaction_date = ?
        WHERE merchant_order_id = ?
          AND status = 'PENDING'
      `
      : `
        UPDATE orders SET
          status = ?,
          transaction_date = ?
        WHERE merchant_order_id = ?
          AND status = 'PENDING'
      `;

    const args = isSuccess
      ? [status, orderNumber, transactionTime, merchantOrderId]
      : [status, transactionTime, merchantOrderId];

    const result = await db.execute({ sql, args });

    console.log(
      `✅ DB UPDATE DONE | Rows: ${result.rowsAffected} | Order#: ${orderNumber || "N/A"}`
    );
  } catch (err) {
    console.error("❌ DB UPDATE FAILED:", err.message || err);
    // webhook must never fail
  }
}

/* ------------------------------------------------
   3) GET ORDER BY MERCHANT ID
------------------------------------------------- */
export async function getOrderByMerchantId(merchantOrderId) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM orders WHERE merchant_order_id = ?",
      args: [merchantOrderId],
    });
    return rows[0] || null;
  } catch (err) {
    console.error("❌ DB GET FAILED:", err);
    throw err;
  }
}

export default db;
