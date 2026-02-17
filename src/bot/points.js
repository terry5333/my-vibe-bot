"use strict";

const { readState, writeState } = require("./storage");

function getAll() {
  const s = readState();
  s.points ??= {};
  s.inventory ??= {};
  s.shop ??= { items: [] };
  writeState(s);
  return s;
}

function getPoints(userId) {
  const s = getAll();
  return Number(s.points[userId] || 0);
}

function addPoints(userId, delta) {
  const s = getAll();
  s.points[userId] = getPoints(userId) + Number(delta || 0);
  writeState(s);
  return s.points[userId];
}

function setPoints(userId, val) {
  const s = getAll();
  s.points[userId] = Number(val || 0);
  writeState(s);
  return s.points[userId];
}

function top(n = 10) {
  const s = getAll();
  const arr = Object.entries(s.points).map(([uid, p]) => ({ uid, p: Number(p || 0) }));
  arr.sort((a, b) => b.p - a.p);
  return arr.slice(0, n);
}

function ensureInv(userId) {
  const s = getAll();
  s.inventory[userId] ??= [];
  writeState(s);
  return s.inventory[userId];
}

module.exports = {
  getPoints,
  addPoints,
  setPoints,
  top,
  ensureInv,
};