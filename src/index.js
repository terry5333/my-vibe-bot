"use strict";

const { startWeb } = require("./web/server");
const { startBot } = require("./bot/client");
const { initFirebase } = require("./db/firebase");

(async () => {
  initFirebase();           // Firebase 先初始化
  startWeb();               // Express 後台
  await startBot();         // Discord Bot
})();
