"use strict";

const admin = require("firebase-admin");

let _app = null;

function initFirebase() {
  if (_app) return _app;

  const raw = process.env.FIREBASE_CONFIG;
  const databaseURL = process.env.FIREBASE_DB_URL;

  if (!raw) throw new Error("Missing env: FIREBASE_CONFIG");
  if (!databaseURL) throw new Error("Missing env: FIREBASE_DB_URL");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_CONFIG must be valid JSON (single line).");
  }

  _app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });

  console.log("[Firebase] Initialized");
  return _app;
}

function getDB() {
  if (!_app) initFirebase();
  return admin.database();
}

module.exports = { initFirebase, getDB };
