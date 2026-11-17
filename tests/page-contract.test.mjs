import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = path => readFileSync(new URL(path,import.meta.url),'utf8');

test('main URL is the setup dashboard, not the Spotify login in OBS',()=>{
  const index=html('../index.html');
  assert.match(index,/dashboard\.js/);
  assert.match(index,/Подключить Spotify/);
  assert.match(index,/overlayLink/);
  assert.doesNotMatch(index,/script\.js/);
});

test('OBS overlay is a separate source without direct Spotify credentials',()=>{
  const overlay=html('../overlay.html');
  assert.match(overlay,/overlay\.js/);
  assert.match(overlay,/spotifyAttribution/);
  assert.doesNotMatch(overlay,/Client ID/);
  assert.doesNotMatch(overlay,/refresh_token/);
});

test('secrets are not placed in Cloudflare worker config',()=>{
  const config=html('../worker/wrangler.toml');
  assert.match(config,/SITE_URL/);
  assert.match(config,/SPOTIFY_CLIENT_ID/);
  assert.doesNotMatch(config,/^TOKEN_ENC_KEY\s*=/m);
  assert.doesNotMatch(config,/^PAIRING_KEY\s*=/m);
});
