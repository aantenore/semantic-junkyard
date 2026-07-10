import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { openDatabase } from "./storage/database.js";

const config = loadRuntimeConfig();
const db = openDatabase(config.databasePath);
const { app } = createApp(db, { runtimeConfig: config });

app.listen(config.port, config.host, () => {
  console.log(`Semantic Junkyard API listening on http://${config.host}:${config.port}`);
});
