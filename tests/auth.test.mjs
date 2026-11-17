import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyAuth, AUTH_KEYS } from '../src/spotify-auth.js';

function store() {
  const data=new Map();
  return {
    getItem:k=>data.has(k)?data.get(k):null,
    setItem:(k,v)=>data.set(k,String(v)),
    removeItem:k=>data.delete(k),
  };
}
const client='a'.repeat(32);
const refresh='r'.repeat(50);
const redirectUri='https://example.github.io/spotify-widget-pkce/index.html';

test('preserves existing localStorage keys and saved refresh token', () => {
  const storage=store();
  storage.setItem(AUTH_KEYS.clientId,client);
  storage.setItem(AUTH_KEYS.tokens,JSON.stringify({
    access_token:'access',refresh_token:refresh,expires_at:Date.now()+600000,
  }));
  const auth=new SpotifyAuth({redirectUri,storage,session:store(),request:async()=>{}});
  assert.equal(auth.hasSession,true);
  assert.equal(auth.clientId,client);
  assert.equal(auth.tokens.refresh_token,refresh);
});

test('rejects malformed import and retains existing credentials', () => {
  const auth=new SpotifyAuth({redirectUri,storage:store(),session:store(),request:async()=>{}});
  assert.throws(()=>auth.importConnection('{}'));
  assert.equal(auth.hasSession,false);
});

test('import/export roundtrip never includes client secret', () => {
  const auth=new SpotifyAuth({redirectUri,storage:store(),session:store(),request:async()=>{}});
  auth.importConnection(JSON.stringify({version:1,client_id:client,refresh_token:refresh}));
  assert.equal(auth.hasSession,true);
  assert.deepEqual(auth.exportConnection(),{version:1,client_id:client,refresh_token:refresh});
  auth.disconnect();
  assert.equal(auth.hasSession,false);
});

test('refresh token rotation is persisted and reused', async () => {
  const storage=store();
  let refreshCalls=0;
  const request=async (_url,opts)=>{
    assert.equal(opts.method,'POST');
    refreshCalls++;
    return {ok:true,json:async()=>({
      access_token:'access-'+refreshCalls,
      refresh_token:'new-refresh-'+refreshCalls,
      expires_in:3600,
    })};
  };
  const auth=new SpotifyAuth({redirectUri,storage,session:store(),request});
  auth.importConnection(JSON.stringify({version:1,client_id:client,refresh_token:refresh}));
  assert.equal(await auth.accessToken(),'access-1');
  assert.equal(auth.tokens.refresh_token,'new-refresh-1');
  assert.equal(await auth.accessToken(),'access-1');
  assert.equal(refreshCalls,1);
});

test('401 triggers forced refresh exactly once', async()=>{
  const storage=store();
  let refreshing=0,apiCalls=0;
  const request=async (url,opts)=>{
    if(url.includes('/api/token')) {
      refreshing++;
      return {ok:true,json:async()=>({access_token:'jwt-'+refreshing,expires_in:3600})};
    }
    apiCalls++;
    return {status:apiCalls===1?401:200};
  };
  const auth=new SpotifyAuth({redirectUri,storage,session:store(),request});
  auth.importConnection(JSON.stringify({version:1,client_id:client,refresh_token:refresh}));
  assert.equal((await auth.authorizedFetch('https://api.spotify.com/v1/me/player/currently-playing')).status,200);
  assert.equal(refreshing,2);
  assert.equal(apiCalls,2);
});

test('invalid_grant invalidates stored session', async()=>{
  const storage=store();
  const request=async()=>({
    ok:false,status:400,
    json:async()=>({error:'invalid_grant',error_description:'revoked'}),
  });
  const auth=new SpotifyAuth({redirectUri,storage,session:store(),request});
  auth.importConnection(JSON.stringify({version:1,client_id:client,refresh_token:refresh}));
  await assert.rejects(()=>auth.accessToken(),/invalid_grant|revoked/);
  assert.equal(auth.hasSession,false);
});
