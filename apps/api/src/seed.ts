import { createApp } from "./app.js";
import { openDatabase } from "./storage/database.js";

const db = openDatabase();
try {
  const { repository, ready } = createApp(db, { seed: true });
  const bootstrap = await ready;
  console.log(JSON.stringify({ status: repository.status(), bootstrap }, null, 2));
} finally {
  db.close();
}
