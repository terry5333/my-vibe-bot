"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "state.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  ensureDir();
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(obj) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf8");
}

module.exports = { readState, writeState };