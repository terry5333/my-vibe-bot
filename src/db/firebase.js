"use strict";

const admin = require("firebase-admin");

const FIREBASE_DB_URL =
  "https://my-pos-4eeee-default-rtdb.asia-southeast1.firebasedatabase.app";

let db = null;

function parseServiceAccount() {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("缺少 FIREBASE_CONFIG");
  const obj = JSON.parse(raw);
  if (obj.private_key && typeof obj.private_key === "string") {
    obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  }
  return obj;
}

function initFirebase() {
  if (db) return db;
  admin.initializeApp({
    credential: admin.credential.cert(parseServiceAccount()),
    databaseURL: FIREBASE_DB_URL,
  });
  db = admin.database();
  console.log("[Firebase] Initialized");
  return db;
}

function getDB() {
  if (!db) throw new Error("Firebase 尚未初始化");
  return db;
}

module.exports = { initFirebase, getDB };
