import { createApp } from "./app.js";
import { openDatabase } from "./storage/database.js";

const db = openDatabase();
const { repository } = createApp(db, { seed: true });

console.log(JSON.stringify(repository.status(), null, 2));
