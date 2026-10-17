import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { studioWords, presets } from '../web/studio-text.js';
import { validateEffects, installEffects, renderEffects } from '../server/effects.js';
import { existsSync } from 'node:fs';

test('studio notation keeps punctuation, overlapping marks, and word indices intact', () => {
  const words = studioWords('I meant *that*, not [*THIS* one]. NASA 123 I');
  assert.deepEqual(words.map(w=>w.text),['I','meant','that,','not','THIS','one.','NASA','123','I']);
  assert.equal(words[2].italic,true);
  assert.equal(words[4].italic && words[4].caps && words[4].link,true);
  assert.equal(words[5].link,true);
  assert.equal(words[7].caps,false);
  assert.equal(words[8].caps,false);
});

test('studio rejects unbounded text and settings', () => {
  const input={words:studioWords('*hello*'),settings:presets.gentle,voice:'af_bella'};
  assert.equal(validateEffects(input).words[0].italic,true);
  assert.throws(()=>validateEffects({...input,words:[{text:'x'.repeat(601)}]}),/600/);
  assert.throws(()=>validateEffects({...input,settings:{...presets.gentle,italic:{...presets.gentle.italic,pitch:Infinity}}}),/pitch/);
  assert.throws(()=>validateEffects({...input,words:[{text:'two words'}]}),/word/);
});

test('studio API sends clean text to speech and keeps original and remapped audio separate', async () => {
  const app=express();app.use(express.json());
  const source={audio:'original',words:[{index:0,start:0,end:1}],duration:1};
  installEffects(app,{generate:async input=>{assert.equal(input.text,'Hello');return source;}},async input=>{
    assert.equal(input.words[0].italic,true);
    return {...source,audio:'processed',duration:1.1,words:[{index:0,start:0,end:1.1}]};
  });
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/effect-studio/render`;
    const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({words:studioWords('*Hello*'),settings:presets.gentle,voice:'af_bella'})};
    const result=await (await fetch(url,options)).json();
    assert.deepEqual(result.original,source);assert.equal(result.processed.words[0].end,1.1);
    assert.equal((await fetch(url,{...options,headers:{...options.headers,origin:'https://evil.example'}})).status,403);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

function tone() {
  const rate=24000, bytes=Buffer.alloc(44+rate*2), source={words:[{index:0,start:.1,end:.4},{index:1,start:.5,end:.9}],duration:1};
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(rate*2,40);
  for(let i=0;i<rate;i++)bytes.writeInt16LE(Math.round(5000*Math.sin(2*Math.PI*180*i/rate)),44+i*2);
  return {...source,audio:bytes.toString('base64')};
}
test('actual processor stretches selected words and moves all later timings consistently', {skip:!existsSync('.venv-effects/bin/python')},async()=>{
  const source=tone(), settings=structuredClone(presets.gentle);
  settings.italic={enabled:true,pitch:2,gain:0,stretch:1.2,echo:0};
  const result=await renderEffects({source,settings,words:[{italic:true},{}]});
  // A .3 second span with two .025 second linear ramps adds .055 seconds.
  assert.ok(Math.abs(result.duration-1.055)<1/24000);
  assert.ok(Math.abs(result.words[0].end-.455)<1e-6);
  assert.ok(Math.abs(result.words[1].start-.555)<1e-6);
  assert.ok(Math.abs(result.words[1].end-.955)<1e-6);
  const bytes=Buffer.from(result.audio,'base64');
  assert.equal((bytes.length-44)/48000,result.duration);
  assert.notEqual(result.audio,source.audio);
  settings.italic.pitch=4; settings.italic.stretch=1;
  const shifted=await renderEffects({source,settings,words:[{italic:true},{}]});
  assert.equal(shifted.duration,source.duration);
  assert.deepEqual(shifted.words,source.words);
  const shiftedBytes=Buffer.from(shifted.audio,'base64');
  let crossings=0;
  for(let i=4801;i<7200;i++)if(shiftedBytes.readInt16LE(44+(i-1)*2)<=0 && shiftedBytes.readInt16LE(44+i*2)>0)crossings++;
  assert.ok(crossings/.1>200 && crossings/.1<250, `Expected raised pitch, measured ${crossings/.1} Hz`);
  for(const s of Object.values(settings))s.enabled=false;
  assert.deepEqual(await renderEffects({source,settings,words:[{italic:true},{}]}),source);
});
