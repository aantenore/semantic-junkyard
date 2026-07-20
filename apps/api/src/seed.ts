import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { openControlPlaneDatabase } from "./storage/database.js";
import { ensureDefaultControlPlaneRoot } from "./storage/defaultControlPlaneRoot.js";

const config = loadRuntimeConfig();
const storage = openControlPlaneDatabase({
  authorizedRoot: ensureDefaultControlPlaneRoot(),
  databasePath: config.databaseRelativePath
});
const { db } = storage;
try {
  const { repository, ready } = createApp(db, {
    seed: true,
    runtimeConfig: config,
    referenceSourcesRoot: storage.referenceSourcesRoot
  });
  const bootstrap = await ready;
  console.log(JSON.stringify({ status: repository.status(), bootstrap }, null, 2));
} finally {
  db.close();
}
