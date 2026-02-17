"use strict";

const initFirebase = require("./firebase");

let db = null;

function getDb() {
  if (db) return db;

  const admin = initFirebase();
  if (!admin) {
    throw new Error("Firebase not initialized");
  }

  db = admin.firestore();
  return db;
}

module.exports = { getDb };