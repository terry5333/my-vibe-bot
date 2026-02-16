"use strict";

const admin = require("firebase-admin");

let _db = null;

function initFirebase() {
  if (_db) return _db;

  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("缺少 FIREBASE_CONFIG env（請放 service account JSON）");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_CONFIG 不是合法 JSON（請確認是一行 JSON 字串）");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://my-pos-4eeee-default-rtdb.asia-southeast1.firebasedatabase.app",
    });
  }

  _db = admin.database();
  console.log("[Firebase] Initialized");
  return _db;
}

function getDB() {
  if (!_db) return initFirebase();
  return _db;
}

module.exports = { initFirebase, getDB };
