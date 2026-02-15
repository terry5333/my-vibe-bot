"use strict";

const { initFirebase } = require("./db/firebase");
const { startWeb } = require("./web/server");
const { startBot } = require("./bot/client");

(async () => {
  initFirebase();
  startWeb();
  await startBot();
})();
