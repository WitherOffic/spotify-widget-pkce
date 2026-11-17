import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtworkController } from '../src/artwork.js';

const id = 'a'.repeat(22);
function fixture() {
  const classes = new Set();
  const images = Array.from({length:4}, () => ({
    src: undefined,
    listeners: {},
    removeAttribute(k) { if (k === 'src') delete this.src; },
    addEventListener(type,callback) { this.listeners[type]=callback; },
  }));
  const container={
    classList:{
      add(k){classes.add(k);},
      remove(k){classes.delete(k);},
      contains(k){return classes.has(k);},
    },
  };
  return {container,images,classes};
}

test('loads public cover without wasting Spotify catalog calls',async()=>{
  const previous = globalThis.Image;
  let calls=0;
  class FakeImage {
    set src(value) {this.value=value;queueMicrotask(()=>this.onload?.());}
  }
  globalThis.Image=FakeImage;
  try {
    const ui=fixture();
    const ctrl=createArtworkController({
      container:ui.container,images:ui.images,
      request:async()=>{calls++;throw Error('Catalog request unnecessary');},
      isRateLimited:()=>false,noteRateLimit:()=>{},
      fetchPublic:async()=>({ok:true,json:async()=>({thumbnail_url:'https://cover.example/art.jpg'})}),
    });
    await ctrl.display('first',{type:'track',id},null);
    assert.equal(ui.images[0].src,'https://cover.example/art.jpg');
    assert.equal(ui.classes.has('has-artwork'),true);
    assert.equal(calls,0);
  } finally { if(previous===undefined)delete globalThis.Image;else globalThis.Image=previous; }
});

test('late image from previous song cannot replace current artwork',async()=>{
  const previous=globalThis.Image;
  const scheduled=[];
  class FakeImage {
    set src(url) {scheduled.push({url,image:this});}
  }
  globalThis.Image=FakeImage;
  try {
    const ui=fixture();
    const ctrl=createArtworkController({
      container:ui.container,images:ui.images,
      request:async()=>({ok:false,status:404}),
      isRateLimited:()=>false,noteRateLimit:()=>{},
      fetchPublic:async()=>({ok:false}),
    });
    const first=ctrl.display('old',{type:'track'},'https://cover.example/old.jpg');
    const second=ctrl.display('new',{type:'track'},'https://cover.example/new.jpg');
    const newJob=scheduled.find(x=>x.url.endsWith('new.jpg'));
    newJob.image.onload();
    await second;
    const oldJob=scheduled.find(x=>x.url.endsWith('old.jpg'));
    oldJob.image.onload();
    await first;
    assert.equal(ui.images[0].src,'https://cover.example/new.jpg');
  } finally { if(previous===undefined)delete globalThis.Image;else globalThis.Image=previous; }
});
