/** 只用于本地视觉验收：复用真实首页组件，测试替身不进入生产入口或平台打包。 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { RuntimeContext } from '../../src/runtime/RuntimeContext';
import type { Runtime } from '../../src/runtime/runtime';
import { SquarePage } from '../../src/pages/square';
import '../../src/styles.css';
import '../../src/official-ui.css';
import '../../src/account-ui.css';

const titles = ['Love Beyond the Contract', 'The CEO’s Hidden Promise'];
const dramas = titles.map((title, index) => ({ id: String(201 + index), title, firstEpisodeId: String(2011 + index), tags: [], episodeCount: 24,
  coverUrl: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="${index ? '#3e5c70' : '#6c435f'}"/><circle cx="200" cy="220" r="100" fill="white" opacity="0.12"/><text x="200" y="430" fill="white" font-size="80" text-anchor="middle">0${index + 1}</text></svg>`) }));
const runtime = { getApplicationBrand: () => ({ name: 'Plotimo' }), loadReviewHome: async () => ({ tiktokAppId: 'visual-only', enabled: true, revision: 1, dramas }) } as unknown as Runtime;
createRoot(document.getElementById('root')!).render(<MemoryRouter><RuntimeContext.Provider value={runtime}><SquarePage session={{ signingIn: false, error: '', onRetry: () => undefined, onNavigate: () => undefined }} /></RuntimeContext.Provider></MemoryRouter>);
