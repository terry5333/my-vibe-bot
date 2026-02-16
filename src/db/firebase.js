"use strict";

const admin = require("firebase-admin");

let _db = null;

function initFirebase() {
  if (admin.apps.length) {
    _db = admin.database();
    console.log("[Firebase] Initialized (reuse)");
    return _db;
  }

  const rawUrl =
    process.env.FIREBASE_DB_URL ||
    process.env.FIREBASE_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!rawUrl) {
    throw new Error("Missing ENV: FIREBASE_DB_URL (Firebase Realtime Database URL)");
  }

  // ✅ 強制把子路徑砍掉，只留 origin（避免你填到 /points 這種）
  let url;
  try {
    url = new URL(rawUrl).origin;
  } catch {
    throw new Error(`Invalid FIREBASE_DB_URL: ${rawUrl}`);
  }

  // 你如果是用 service account JSON，通常是放在 FIREBASE_SERVICE_ACCOUNT
  // 或者用 GOOGLE_APPLICATION_CREDENTIALS 指到檔案
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      databaseURL: url,
    });
  } else {
    // 讓平台（Render/Railway）用預設認證方式（如果你有設定）
    admin.initializeApp({
      databaseURL: url,
    });
  }

  _db = admin.database();
  console.log("[Firebase] Initialized");
  return _db;
}

function getDB() {
  if (!_db) initFirebase();
  return _db;
}

module.exports = { initFirebase, getDB };
