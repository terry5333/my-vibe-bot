"use strict";

const admin = require("firebase-admin");

let appInitialized = false;

function initFirebase() {
  if (appInitialized || admin.apps.length > 0) return admin;

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  if (!b64) {
    console.warn("[Firebase] FIREBASE_SERVICE_ACCOUNT_B64 not set");
    return null;
  }

  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const serviceAccount = JSON.parse(json);

    const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID;

    // ✅ 讓其他 Google SDK 也能讀到（避免 Unable to detect a Project Id）
    if (projectId && !process.env.GOOGLE_CLOUD_PROJECT) {
      process.env.GOOGLE_CLOUD_PROJECT = projectId;
    }
    if (projectId && !process.env.GCLOUD_PROJECT) {
      process.env.GCLOUD_PROJECT = projectId;
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId, // ✅ 明確指定
    });

    appInitialized = true;
    console.log(`[Firebase] Initialized (projectId=${projectId || "unknown"})`);
    return admin;
  } catch (err) {
    console.error("[Firebase] Init failed:", err);
    throw err;
  }
}

module.exports = initFirebase;