import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextTransition } from '../src/track-animation.js';

function fakeText(value) {
  return { textContent: value, animate: () => ({cancel(){},finished: Promise.resolve()}) };
}
test('can update track text without browser animation APIs', () => {
  const viewport = {querySelectorAll: () => []};
  const title = {textContent:'Old'};
  const artist = {textContent:'Old artist'};
  const transition = createTextTransition(viewport,title,artist,{enabled:false});
  transition.animate('New track','New artist',true);
  assert.equal(title.textContent,'New track');
  assert.equal(artist.textContent,'New artist');
  transition.cancel();
});
test('falls back when animations are unsupported', () => {
  const viewport = {querySelectorAll: () => []};
  const title = {textContent:'Old'};
  const artist = {textContent:'Old artist'};
  const transition = createTextTransition(viewport,title,artist,{enabled:true});
  transition.animate('Another','Artist',true);
  assert.equal(title.textContent,'Another');
});
test('initial animation works without creating an outgoing ghost', async () => {
  const viewport = {querySelectorAll: () => [], appendChild(){throw Error('unexpected ghost')}};
  const title = fakeText('Old');
  const artist = fakeText('Old artist');
  const transition = createTextTransition(viewport,title,artist,{enabled:true});
  transition.animate('First','Someone',false);
  assert.equal(title.textContent,'First');
  assert.equal(artist.textContent,'Someone');
  await Promise.resolve();
  transition.cancel();
});
