import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPublicHomeCache } from './publicHomeCache';

beforeEach(()=>{
  const entries=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{entries.set(key,value)}});
});
afterEach(()=>vi.unstubAllGlobals());

it('配置确认前不显示旧首页，开启、关闭及变更修订各自隔离缓存',async()=>{
  let scope:string|undefined;
  let ids=['normal'];
  const load=vi.fn(async()=>ids.map(id=>({id,firstEpisodeId:'1',title:id,description:'',coverUrl:'',episodeCount:1,tags:[],status:'completed' as const})));
  const prepare=vi.fn(async()=>{});
  const cache=createPublicHomeCache('app','https://api.test',load,load,async()=>[],async()=>({dramas:await load()}),{scope:()=>scope,prepare});
  expect(cache.carousel.snapshot()).toBeUndefined();
  await expect(cache.carousel.load()).rejects.toThrow(/not confirmed/);
  scope='0.1.0:normal:1';await cache.carousel.load();
  expect(cache.carousel.snapshot()?.map(row=>row.id)).toEqual(['normal']);
  scope='0.1.0:review:2';ids=['selected'];
  expect(cache.carousel.snapshot()).toBeUndefined();
  await cache.carousel.load();
  expect(cache.carousel.snapshot()?.map(row=>row.id)).toEqual(['selected']);
  scope='0.1.0:normal:3';ids=['restored'];
  expect(cache.carousel.snapshot()).toBeUndefined();
  await cache.carousel.load();
  expect(cache.carousel.snapshot()?.map(row=>row.id)).toEqual(['restored']);
});

it('审核修订改变后，迟到的普通结果不能进入缓存或页面',async()=>{
  let scope='normal';
  let finish!:(value:[])=>void;
  const first=new Promise<[]>(resolve=>{finish=resolve});
  const cache=createPublicHomeCache('app','https://api.test',()=>first,async()=>[],async()=>[],async()=>({dramas:[]}),{scope:()=>scope,prepare:async()=>{}});
  const pending=cache.carousel.load();
  await Promise.resolve();scope='review';finish([]);
  await expect(pending).rejects.toThrow(/changed/);
  expect(cache.carousel.snapshot()).toBeUndefined();
});
