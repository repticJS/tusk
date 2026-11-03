import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RdpWindow } from "./components/RdpWindow";
import { popoutSession } from "./lib/window";
import { useApp } from "./store";
import "./index.css";

document.documentElement.dataset.theme = useApp.getState().theme;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{popoutSession ? <RdpWindow sessionId={popoutSession} /> : <App />}</React.StrictMode>,
);
