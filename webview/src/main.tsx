import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";  // after App so our tokens win over @xyflow/react's css

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
