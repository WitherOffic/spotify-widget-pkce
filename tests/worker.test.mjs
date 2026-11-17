import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{projectCurrent,seal,unseal} from '../worker/src/index.js';

const env={
  DB:{},
  SPOTIFY_CLIENT_ID:'a'.repeat(32),
  SITE_URL:'https://witheroffic.github.io/spotify-widget-pkce/index.html',
  TOKEN_ENC_KEY:Buffer.from(new Uint8Array(32).fill(4)).toString('base64'),
  PAIRING_KEY:'secret_test_pairing_key_secret_123',
};

test('server only returns the public song fields',()=>{
  const song=projectCurrent({
    is_playing:true,progress_ms:1234,
    item:{
      id:'a'.repeat(22),uri:'spotify:track:'+'a'.repeat(22),
      name:'New track',duration_ms:240000,
      artists:[{name:'Artist A'},{name:'Artist B'}],
      album:{images:[{url:'https://i.scdn.co/cover'}]},
      external_urls:{spotify:'https://open.spotify.com/track/'+'a'.repeat(22)},
      secret_field:'never return',
    },
  });
  assert.equal(song.playing,true);
  assert.equal(song.artist,'Artist A, Artist B');
  assert.equal(song.image,'https://i.scdn.co/cover');
  assert.equal(song.progressMs,1234);
  assert.equal(song.spotifyUrl.startsWith('https://open.spotify.com/'),true);
  assert.equal(JSON.stringify(song).includes('secret_field'),false);
  assert.equal(projectCurrent(null).playing,false);
  assert.equal(projectCurrent({is_playing:false,item:{}}).playing,false);
});

test('server encrypts Spotify refresh token before persistence',async()=>{
  const encrypted=await seal(env,{refresh_token:'sensitive-user-refresh-token'});
  assert.equal(encrypted.includes('sensitive-user-refresh-token'),false);
  assert.deepEqual(await unseal(env,encrypted),{refresh_token:'sensitive-user-refresh-token'});
});

test('worker health is public but does not expose secrets',async()=>{
  const req=new Request('https://example.workers.dev/api/health',{
    headers:{Origin:'https://witheroffic.github.io'},
  });
  const res=await worker.fetch(req,env);
  assert.equal(res.status,200);
  const data=await res.json();
  assert.deepEqual(data,{ready:true});
  assert.equal(JSON.stringify(data).includes(env.PAIRING_KEY),false);
  assert.equal(res.headers.get('access-control-allow-origin'),'https://witheroffic.github.io');
});

test('worker rejects foreign browser origins',async()=>{
  const res=await worker.fetch(new Request('https://example.workers.dev/api/now',{
    method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},
    body:JSON.stringify({id:'a'.repeat(24),viewKey:'b'.repeat(43)}),
  }),env);
  assert.equal(res.status,403);
  assert.equal((await res.json()).error,'origin_not_allowed');
});

test('worker fails closed if backend is not configured',async()=>{
  const res=await worker.fetch(new Request('https://example.workers.dev/api/health'),{
    SITE_URL:env.SITE_URL,SPOTIFY_CLIENT_ID:env.SPOTIFY_CLIENT_ID,
  });
  assert.equal(res.status,503);
});
