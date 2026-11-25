import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { RuntimeContext } from '../../runtime/RuntimeContext';
import type { Runtime } from '../../runtime/runtime';
import { SquarePage } from './index';

// 首页路由测试保留真实审核渲染，只以测试组件标记普通首页栏目是否挂载。
vi.mock('../../components/HomeHighlights', () => ({ HomeHighlights: () => <div>Normal category carousel hot</div> }));
vi.mock('../../components/DramaPoster', () => ({ DramaPoster: ({ drama }: { drama: { title: string } }) => <div>{drama.title}</div> }));
vi.mock('../../runtime/useAdExperience', () => ({ useAdExperience: () => ({ monetizationPolicy: { status: 'disabled' }, vipState: { active: false } }) }));
vi.mock('../../components/useForegroundRefresh', () => ({ useForegroundRefresh: () => undefined }));
vi.mock('./usePlaybackPreload', () => ({ usePlaybackPreload: () => undefined }));
vi.mock('../../components/BottomNav', () => ({ BottomNav: () => <nav>Navigation</nav> }));

function setup(enabled: boolean) {
  const loadReviewHome = vi.fn(async () => ({ tiktokAppId: 'app', enabled, revision: 1, dramas: [{ id: 'review', title: 'Review drama' }] }));
  const loadPublicCatalog = vi.fn(async () => ({ dramas: [{ id: 'normal', title: 'Normal drama', coverUrl: '', tags: [] }] }));
  const runtime = { loadReviewHome, loadPublicCatalog, api: {}, getApplicationBrand: () => ({ name: 'Drama' }) } as unknown as Runtime;
  render(<MemoryRouter><RuntimeContext.Provider value={runtime}><SquarePage /></RuntimeContext.Provider></MemoryRouter>);
  return { runtime, loadReviewHome, loadPublicCatalog };
}

it('命中审核版本只展示审核列表，分类、轮播、热播及原短剧列表均不挂载', async () => {
  const { loadPublicCatalog } = setup(true);
  await screen.findByText('Review drama');
  expect(screen.queryByText('Normal category carousel hot')).not.toBeInTheDocument();
  expect(screen.queryByText('Normal drama')).not.toBeInTheDocument();
  expect(screen.queryByText('More Drama')).not.toBeInTheDocument();
  expect(loadPublicCatalog).not.toHaveBeenCalled();
});

it('未命中审核版本继续展示原栏目和原短剧目录', async () => {
  setup(false);
  await screen.findByText('Normal drama');
  expect(screen.getByText('Normal category carousel hot')).toBeInTheDocument();
  expect(screen.getByText('More Drama')).toBeInTheDocument();
  expect(screen.queryByText('Review drama')).not.toBeInTheDocument();
});

it('审核接口故障不展示普通首页内容，重试成功后展示审核列表', async () => {
  const { runtime, loadPublicCatalog } = setup(true);
  await screen.findByText('Review drama');
  const retry = vi.fn().mockRejectedValueOnce(new Error('dependency unavailable')).mockResolvedValue({ tiktokAppId: 'app', enabled: true, revision: 2, dramas: [{ id: 'second', title: 'Updated review drama' }] });
  const replacement = { ...runtime, loadReviewHome: retry };
  render(<MemoryRouter><RuntimeContext.Provider value={replacement}><SquarePage /></RuntimeContext.Provider></MemoryRouter>);
  await screen.findByRole('alert');
  expect(screen.queryByText('Normal drama')).not.toBeInTheDocument();
  await act(async () => screen.getByRole('button').click());
  await waitFor(() => expect(screen.getByText('Updated review drama')).toBeInTheDocument());
  expect(loadPublicCatalog).not.toHaveBeenCalled();
});
