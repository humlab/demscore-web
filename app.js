import { DemscoreApp } from "./src/DemscoreApp.js";

const app = new DemscoreApp();
app.start().catch((err) => {
  const root = document.getElementById("app");
  if (root) {
    root.innerHTML = `<pre style=\"padding:16px;color:#b91c1c\">${String(err)}</pre>`;
  }
  console.error(err);
});
