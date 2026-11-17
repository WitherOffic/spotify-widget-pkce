import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, parsePollMs, formatTime, retryAfterMs,
  normalizeTrack, progressAt, getOAuthErrorMessage,
} from '../player-core.js';

test('poll interval is bounded and defaults to 3 seconds', () => {
  assert.equal(parsePollMs(), 3000);
  assert.equal(parsePollMs('2000'), 2000);
  assert.equal(parsePollMs(250), 2000);
  assert.equal(parsePollMs(600000), 60000);
  assert.equal(parsePollMs('invalid'), 3000);
});

test('format time handles boundaries', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(60999), '1:00');
  assert.equal(formatTime(3599000), '59:59');
  assert.equal(formatTime(-100), '0:00');
});

test('retry-after accepts delta seconds and HTTP date', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('not-a-date'), null);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
});

test('normal playback is converted into a safe model', () => {
  const song = normalizeTrack({
    is_playing: true, progress_ms: 1000,
    currently_playing_type: 'track',
    item: {
      uri: 'spotify:track:demo', name: '<script>nothing</script>', type: 'track',
      duration_ms: 90000,
      artists: [{ name: 'First' }, { name: 'Second' }],
      album: { images: [{url: 'https://i.scdn.co/example'}] },
    },
  });
  assert.equal(song.title, '<script>nothing</script>');
  assert.equal(song.artist, 'First, Second');
  assert.equal(song.image, 'https://i.scdn.co/example');
  assert.equal(song.progressMs, 1000);
});

test('missing cover never breaks a playing track', () => {
  const song = normalizeTrack({
    is_playing: true, progress_ms: 1500,
    item: {name: 'Unnamed', duration_ms: 2000, artists: []},
  });
  assert.equal(song.image, null);
  assert.equal(song.artist, 'Spotify');
});

test('pause, ad, and absent item hide overlay', () => {
  assert.equal(normalizeTrack({is_playing:false,item:{name:'A'}}),null);
  assert.equal(normalizeTrack({is_playing:true,currently_playing_type:'ad',item:{name:'A'}}),null);
  assert.equal(normalizeTrack({is_playing:true}),null);
});

test('player position is constrained to song duration', () => {
  const song = {progressMs:2000,durationMs:10000};
  assert.equal(progressAt(song,1000),3000);
  assert.equal(progressAt(song,100000),10000);
  assert.equal(progressAt(song,-1000),2000);
  assert.equal(progressAt(null,1000),0);
  assert.equal(clamp(15,0,10),10);
});

test('API errors do not expose credentials', () => {
  assert.match(getOAuthErrorMessage(401), /401/);
  assert.match(getOAuthErrorMessage(403), /403/);
  assert.match(getOAuthErrorMessage(429, 'limited'), /429/);
});
