/** 仅用于浏览器视觉回归的入口；不进入正式构建，不调用业务服务或官方 SDK。 */
import { createRoot } from "react-dom/client";
import { HashRouter, Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AccountHeader } from "../../src/components/AccountHeader";
import { BottomNav } from "../../src/components/BottomNav";
import { LibraryPage } from "../../src/pages/LibraryPage";
import { ProfilePage } from "../../src/pages/ProfilePage";
import { AgreementPage, PrivacyPolicyPage } from "../../src/pages/LegalPage";
import { LocalLibraryStore } from "../../src/domain/localLibrary";
import type { Runtime } from "../../src/runtime/runtime";
import { RuntimeContext } from "../../src/runtime/RuntimeContext";
import "../../src/styles.css";
import "../../src/official-ui.css";
import "../../src/account-ui.css";

const state = new URLSearchParams(window.location.search).get("state");
const values = new Map<string, string>();
const library = new LocalLibraryStore("visual-fixture", "fixture-visitor", {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
});
if (state === "grouped") {
  library.recordProgress({ dramaId: "fixture-drama", episodeId: "fixture-episode-5", episodeNumber: 5, progressSeconds: 40, durationSeconds: 60 });
  library.recordProgress({ dramaId: "fixture-other", episodeId: "other-episode-1", episodeNumber: 1, progressSeconds: 30, durationSeconds: 60 });
}
if (state !== "empty") library.recordProgress({ dramaId: "fixture-drama", episodeId: "fixture-episode-2", episodeNumber: 2, progressSeconds: 1, durationSeconds: 60 });
const drama = {
  id: "fixture-drama", firstEpisodeId: "fixture-episode-1", title: "The Devilish Lord and His Lamb Nun",
  description: "", coverUrl: "", episodeCount: 35,
  tags: ["Misunderstanding", "Taboo", "Possessiveness", "Morality"], status: "completed",
};
library.updateHistorySummary({ ...drama, status: "completed" });
if (state === "grouped") library.updateHistorySummary({ ...drama, id: "fixture-other", title: "Another Story", status: "completed" });
const runtime = {
  getApplicationBrand: () => ({ name: "Plotimo", logoUrl: "" }),
  getVisitorID: () => "2099779656359661570",
  localLibrary: library,
} as unknown as Runtime;
/** PlaybackRoute 显示实际链接目标，仅核验续播路由，不模拟官方播放能力。 */
function PlaybackRoute() {
  const { dramaId, episodeId } = useParams();
  return <main className="account-page"><AccountHeader /><h1>Playback route</h1><p>{dramaId} / {episodeId}</p><Link to="/library">Back to History</Link></main>;
}
// 对照图去掉系统状态栏后，保留底部 34 CSS px 的原生安全区；不绘制系统 UI。
document.documentElement.style.setProperty("--minis-bottom", "34px");
createRoot(document.getElementById("root")!).render(<RuntimeContext.Provider value={runtime}><HashRouter><Routes>
  <Route path="/library" element={<LibraryPage />} />
  <Route path="/profile" element={<ProfilePage />} />
  <Route path="/privacy" element={<PrivacyPolicyPage />} />
  <Route path="/agreement" element={<AgreementPage />} />
  <Route path="/watch/:dramaId/:episodeId" element={<PlaybackRoute />} />
  <Route path="/" element={<main className="account-page"><AccountHeader /><h1>Home route</h1><BottomNav /></main>} />
  <Route path="*" element={<Navigate to="/profile" replace />} />
</Routes></HashRouter></RuntimeContext.Provider>);
