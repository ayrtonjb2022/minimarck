import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastContainer } from "react-toastify";

import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { CajaProvider } from "./context/CajaContext";
import { NotificacionProvider } from "./context/NotificacionContext";
import { ThemeProvider } from "./context/ThemeContext";
import { queryClient } from "./services/queryClient";

import "./styles/index.css";
import "./styles/icons.css";
import "react-toastify/dist/ReactToastify.css";

/**
 * Paint the saved theme BEFORE React renders.
 *
 * ThemeProvider sets the class in a `useEffect`, which runs after the first commit — far
 * enough that the window would open, repaint in the default palette, and then snap to the
 * operator's saved one. On a till that reads as a flicker on every launch.
 *
 * The fix cannot be an inline `<script>`: `script-src 'self'` has no `'unsafe-inline'`
 * (that is the same policy OFFL-2 proves at runtime by trying to run an inline script and
 * requiring it to FAIL), so an inline boot script would simply be blocked. Setting the class
 * here, at the top of a real module, is the CSP-legal equivalent: this module is already
 * executing before the first paint, and ThemeProvider reads the same key, so the two agree
 * and there is no flash to correct.
 */
const THEME_KEY = "mm-theme";
try {
  const saved = localStorage.getItem(THEME_KEY);
  const initial = saved === "dark" || saved === "light" ? saved : "light";
  document.documentElement.classList.add(`mm-theme-${initial}`);
  document.documentElement.style.colorScheme = initial;
} catch {
  // Storage unavailable: ThemeProvider still picks a theme, it just will not remember it.
}

/**
 * BrowserRouter, deliberately, and the reason it still works.
 *
 * A deep link like `app://bundle/ventas` has no server in front of it to rewrite the request
 * to index.html, which is the usual reason a packaged SPA drops to HashRouter. Here main owns
 * the `app://` protocol: `isNavigationRequest()` in src/main/protocol.js treats a path with no
 * file extension as a ROUTE and serves index.html for it, and 404s a missing asset instead.
 * So `/ventas` loads the app, React reads the path, and the route matches — with a readable
 * URL and no `#` in it. `npm run probe:launch` boots the built app over that exact origin and
 * asserts the result, so this is proved rather than hoped for.
 */
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <CajaProvider>
              <NotificacionProvider>
                <App />
                <ToastContainer
                  position="top-right"
                  autoClose={3000}
                  hideProgressBar={false}
                  newestOnTop
                  closeOnClick
                  rtl={false}
                  pauseOnFocusLoss
                  draggable
                  pauseOnHover
                  theme="colored"
                />
              </NotificacionProvider>
            </CajaProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
