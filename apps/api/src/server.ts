import { createApp } from "./app.js";
import { openDatabase } from "./storage/database.js";

const port = Number(process.env.PORT ?? 8787);
const db = openDatabase();
const { app } = createApp(db);

app.listen(port, () => {
  console.log(`Semantic Junkyard API listening on http://localhost:${port}`);
});
