/** 选集视觉夹具仅装配真实组件，不接入正式入口或模拟播放能力。 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EpisodeSheet } from "../../src/components/EpisodeSheet";
import type { DramaDetail } from "../../src/domain/types";
import "../../src/styles.css";
import "../../src/official-ui.css";

const params = new URLSearchParams(location.search);
const drama: DramaDetail = {
  id: "visual", firstEpisodeId: "1", title: "One Night, Everything Shifted", description: "", tags: [], status: "completed", episodeCount: 81,
  coverUrl: params.get("cover") ?? "/tests/visual/assets/one-night-cover.jpg",
  episodes: Array.from({ length: 81 }, (_, index) => ({ id: String(index + 1), dramaId: "visual", number: index + 1, title: `Episode ${index + 1}`, description: "", posterUrl: "", durationSeconds: 60, accessMode: params.has("locked") && index > 5 ? "rewarded" : "free" })),
};
function Fixture() {
  const [open, setOpen] = useState(true);
  const [episodeId, setEpisodeId] = useState(params.get("episode") ?? "1");
  return <main className="app-shell theater-page" style={{ minHeight: "100dvh", background: "#151518" }}>
    <button onClick={() => setOpen(true)} style={{ margin: 24 }}>Episodes</button>
    <p style={{ padding: 24 }}>Current episode: {episodeId}</p>
    {open && <EpisodeSheet drama={drama} episodeId={episodeId} vipActive={false} onClose={() => setOpen(false)} onSelect={setEpisodeId} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
