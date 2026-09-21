import { createRoot } from "react-dom/client";
import { App } from "./App";

// The page controls this Host, so it never renders inside another page.
if (window.top === window.self)
  createRoot(document.getElementById("root")!).render(<App />);
