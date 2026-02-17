"use strict";

/**
 * 只處理 admin slash（install/close/ping）
 * index.js 已經 deferReply(ephemeral)
 */

const admin = require("./commands_admin");

async function execute(interaction, ctx) {
  return admin.execute(interaction, ctx);
}

module.exports = { execute };