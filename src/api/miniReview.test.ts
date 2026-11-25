import { expect, it, vi } from 'vitest';
import { HttpMiniDramaApi } from './httpMiniDramaApi';
import { miniAppVersion } from '../config/miniVersion';

const config={applicationId:'101',tiktokAppId:'test-app',appName:'Review',logoUrl:'',complianceBaseUrl:'',monetization:{vip:{enabled:false}},miniReview:{enabled:true,episodeOnly:true,revision:4},playbackSdk:{provider:'tiktok_minis',channel:'byteplus'}};
const json=(data:unknown)=>new Response(JSON.stringify({code:0,data}),{status:200});

it('审核首页使用新增接口，原分类、轮播、热播和短剧目录保持原请求参数',async()=>{
 const fetcher=vi.fn<typeof fetch>(async input=>{
  const path=String(input);
  if(path.includes('/open/review-home'))return json({tiktokAppId:'test-app',enabled:true,revision:4,dramas:[]});
  if(path.includes('/open/app-config'))return json(config);
  if(path.includes('/open/catalog'))return json({tiktokAppId:'test-app',dramas:[]});
  return json([]);
 });
 const api=new HttpMiniDramaApi('https://api.test',fetcher);
 await api.appConfig('test-app');
 await api.reviewHome('test-app');
 await api.homeCarousel('test-app');await api.homeHot('test-app');await api.homeRankings('test-app');
 await api.publicCatalog('test-app',{limit:20});
 await api.publicCatalog('test-app',{query:'ordinary search'});
 for(const [,init] of fetcher.mock.calls)expect(new Headers(init?.headers).get('X-Mini-Version')).toBe(miniAppVersion());
 expect(String(fetcher.mock.calls[1][0])).toContain('/api/v1/open/review-home?tiktokAppId=test-app');
 expect(fetcher.mock.calls[1][1]?.cache).toBe('no-store');
 for(const [url] of fetcher.mock.calls.slice(2))expect(String(url)).not.toMatch(/placement=|reviewRevision=/);
});

it('损坏的审核配置不能被安装为首页缓存修订',async()=>{
 const api=new HttpMiniDramaApi('https://api.test',vi.fn(async()=>json({...config,miniReview:{...config.miniReview,revision:-1}})));
 await expect(api.appConfig('test-app')).rejects.toMatchObject({code:'invalid_response'});
});

 it('审核首页拒绝错误应用和损坏响应，不降级读取普通首页',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>json({tiktokAppId:'other-app',enabled:true,revision:4,dramas:[]}));
  const api=new HttpMiniDramaApi('https://api.test',fetcher);
  await expect(api.reviewHome('test-app')).rejects.toMatchObject({code:'invalid_response'});
  expect(fetcher).toHaveBeenCalledOnce();
 });
