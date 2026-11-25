import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";

import { App } from "./App";
import { AgreementPage, PrivacyPolicyPage } from "./pages/LegalPage";
import type { Runtime } from "./runtime/runtime";
import type { ApplicationStartup } from "./runtime/startup";
import type { SquarePage } from "./pages/square";

/** mountApplication 复用提前发起的启动任务和普通入口的首页组件；法律页不创建业务 Runtime。 */
export function mountApplication(runtime?: Runtime, startup?: ApplicationStartup, initialHomePage?: typeof SquarePage): void {
  const content = runtime ? <App runtime={runtime} startup={startup} initialHomePage={initialHomePage} /> : (
    <HashRouter>
      <Routes>
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/agreement" element={<AgreementPage />} />
      </Routes>
    </HashRouter>
  );
  createRoot(document.getElementById("root")!).render(<StrictMode>{content}</StrictMode>);
}
