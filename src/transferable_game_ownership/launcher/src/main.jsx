import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Anchor's borsh codecs expect Node's Buffer to exist as a global.
globalThis.Buffer = globalThis.Buffer ?? Buffer;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
