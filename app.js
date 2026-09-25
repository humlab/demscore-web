import "@fontsource/lato/300.css";
import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import "@fontsource/lato/900.css";
import "@fontsource/open-sans/300.css";
import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/700.css";
import "ol/ol.css";
import "./styles.css";
import { DemscoreApp } from "./src/DemscoreApp.js";
import { refreshIcons } from "./src/core/icons.js";

const app = new DemscoreApp();
refreshIcons();
app.start().catch((err) => {
  const root = document.getElementById("app");
  if (root) {
    root.innerHTML = `<pre style=\"padding:16px;color:#b91c1c\">${String(err)}</pre>`;
  }
  console.error(err);
});
