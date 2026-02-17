"use strict";

const admin = require("firebase-admin");

let appInitialized = false;

function initFirebase() {
  if (appInitialized || admin.apps.length > 0) {
    return admin;
  }

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  if (!b64) {
    console.warn("[Firebase] FIREBASE_SERVICE_ACCOUNT_B64 not set");
    return null;
  }

  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const serviceAccount = JSON.parse(json);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    appInitialized = true;
    console.log("[Firebase] Initialized (Firestore ready)");
    return admin;
  } catch (err) {
    console.error("[Firebase] Init failed:", err);
    throw err;
  }
}

module.exports = initFirebase;