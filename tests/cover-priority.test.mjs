import test from 'node:test';
import assert from 'node:assert/strict';
import {preferPublicCover} from '../src/cover-priority.js';
import {publicThumbnail} from '../src/public-artwork.js';

test('public oEmbed image is primary; direct API image is not loaded needlessly', async () => {
  const tried = [];
  const result = await preferPublicCover({
    lookupPublic:async()=> 'https://img.example/public.jpg',
    backupUrl:'https://img.example/api.jpg',
    probe:async url=>{ tried.push(url); return true; },
    delay:async()=>{},
  });
  assert.equal(result,'https://img.example/public.jpg');
  assert.deepEqual(tried,['https://img.example/public.jpg']);
});

test('falls back immediately when oEmbed is blocked',async()=>{
  const tried = [];
  const result = await preferPublicCover({
    lookupPublic:async()=>null,
    backupUrl:'https://img.example/api.jpg',
    probe:async url=>{tried.push(url);return true},
    delay:async()=>{},
  });
  assert.equal(result,'https://img.example/api.jpg');
  assert.deepEqual(tried,['https://img.example/api.jpg']);
});

test('backup can win when public lookup stalls; does not wait 10 seconds',async()=>{
  let finishPublic;
  const publicLookup=new Promise(resolve=>{finishPublic=resolve});
  const result=await preferPublicCover({
    lookupPublic:()=>publicLookup,
    backupUrl:'https://img.example/api.jpg',
    probe:async()=>true,
    delay:async()=>{},
  });
  assert.equal(result,'https://img.example/api.jpg');
  finishPublic('https://img.example/public.jpg');
  await new Promise(resolve=>setImmediate(resolve));
});

test('uses API image if public thumbnail URL is not actually loadable',async()=>{
  const tried=[];
  const result=await preferPublicCover({
    lookupPublic:async()=> 'https://img.example/broken.jpg',
    backupUrl:'https://img.example/working.jpg',
    probe:async url=>{tried.push(url);return !url.includes('broken');},
    delay:async()=>new Promise(resolve=>setImmediate(resolve)),
  });
  assert.equal(result,'https://img.example/working.jpg');
  assert.deepEqual(tried,['https://img.example/broken.jpg','https://img.example/working.jpg']);
});

test('returns null when all cover sources are unavailable',async()=>{
  const result=await preferPublicCover({
    lookupPublic:async()=>null,backupUrl:null,probe:async()=>false,delay:async()=>{},
  });
  assert.equal(result,null);
});

test('default publicThumbnail fetch retains the browser global receiver',async()=>{
  const oldFetch=globalThis.fetch;
  const id='a'.repeat(22);
  globalThis.fetch=async function (_url) {
    assert.equal(this,globalThis);
    return {ok:true,json:async()=>({thumbnail_url:'https://img.example/ok.jpg'})};
  };
  try {
    assert.equal(await publicThumbnail({id:'spotify:track:'+id}),
      'https://img.example/ok.jpg');
  } finally {
    globalThis.fetch=oldFetch;
  }
});
