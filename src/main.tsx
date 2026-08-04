import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import App from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
