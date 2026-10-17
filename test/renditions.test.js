import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRenditions } from '../server/renditions.js';

const words = Array.from({length:160}, (_,i) => ({text:`word${i}.`,sentence:Math.floor(i/10)}));
const input = {voice:'af_bella',view:'reader',words};
const result = {audio:'UklGRg==',words:[{index:0,start:.1,end:.4}],duration:.5};
async function until(check) {
  for (let i=0;i<100;i++) { if (check()) return; await new Promise(r=>setTimeout(r,5)); }
  assert.fail('Generation did not reach the expected state');
}
function fixture() { const directory = mkdtempSync(join(tmpdir(),'voicesite-speech-')); return {directory,cleanup:()=>rmSync(directory,{recursive:true,force:true})}; }

test('full-page generation saves in order, survives restart, and reuses every clip without inference', async () => {
  const f = fixture(), calls = [];
  let manager = createRenditions({directory:f.directory,speech:{generate:async args=>{calls.push(args);return result;}}});
  try {
    const job = manager.ensure('snapshot-1',input);
    assert.ok(job.total > 1);
    assert.ok(job.chunks.every(c => c.duration === null));
    manager.generate(job.id);
    await until(()=>manager.status(job.id).status === 'complete');
    assert.equal(calls.length,job.total);
    assert.equal(calls.map(c=>c.text).join(' '),words.map(w=>w.text).join(' '));
    manager.close();
    manager = createRenditions({directory:f.directory,speech:{generate:()=>assert.fail('Saved audio must not regenerate')}});
    assert.equal(manager.ensure('snapshot-1',input).id,job.id);
    assert.equal(manager.status(job.id).status,'complete');
    assert.ok(manager.status(job.id).chunks.every(c => c.duration === result.duration));
    for(let i=0;i<job.total;i++) assert.deepEqual(await manager.chunk(job.id,i),result);
    const otherVersion = manager.ensure('snapshot-2',input);
    assert.notEqual(otherVersion.id,job.id);
    assert.equal(otherVersion.status,'complete'); // Identical text can share immutable clips.
    assert.equal(manager.ensure('snapshot-1',{...input,voice:'am_eric'}).ready,0);
  } finally { manager.close(); f.cleanup(); }
});

test('concurrent word clicks and full generation share one inference; incomplete work resumes', async () => {
  const f = fixture(); let release, calls = 0;
  let manager = createRenditions({directory:f.directory,speech:{generate:async ()=>{calls++; await new Promise(r=>{release=r;}); return result;}}});
  try {
    const job = manager.ensure('snapshot',input);
    const first = manager.chunk(job.id,0), second = manager.chunk(job.id,0);
    manager.generate(job.id);
    assert.equal(calls,1);
    manager.close(); release(); await Promise.all([first,second]);
    manager = createRenditions({directory:f.directory,speech:{generate:async ()=>{calls++;return result;}}});
    await until(()=>manager.status(job.id).status==='complete');
    assert.equal(calls,job.total);
  } finally { manager.close(); f.cleanup(); }
});

test('failed full-page jobs are retryable without discarding completed audio', async () => {
  const f = fixture(); let calls=0, fail=true;
  const manager = createRenditions({directory:f.directory,speech:{generate:async ()=>{calls++;if(calls===2 && fail)throw new Error('Model offline');return result;}}});
  try {
    const job = manager.ensure('snapshot',input);
    manager.generate(job.id);
    await until(()=>manager.status(job.id).status==='error');
    assert.equal(manager.status(job.id).ready,1);
    fail=false;manager.generate(job.id);
    await until(()=>manager.status(job.id).status==='complete');
    assert.equal(calls,job.total+1);
    assert.throws(()=>manager.status('../escape'),/not found/);
    assert.throws(()=>manager.ensure('snapshot',{...input,voice:'unlisted'}),/Invalid/);
  } finally {manager.close();f.cleanup();}
});

test('click-to-read advertises saving, promotes the clicked chunk and its successors', async () => {
  const f=fixture(), calls=[], promotions=[], releases=[];
  const manager=createRenditions({directory:f.directory,speech:{
    generate:async (input,signal,priority)=>{calls.push({input,priority});await new Promise(r=>releases.push(r));return result;},
    prioritize:(input,priority)=>promotions.push({input,priority}),
  }});
  try {
    const job=manager.ensure('snapshot',input);
    const last=job.total-1;
    const state=manager.prioritize(job.id,last);
    assert.equal(state.status,'generating');
    assert.equal(state.fullGeneration,false);
    assert.equal(calls.length,1);
    const higher=manager.prioritize(job.id,last);
    assert.equal(higher.status,'generating');
    assert.equal(calls.length,1);
    assert.ok(promotions.at(-1).priority>calls[0].priority);
    const work=manager.chunk(job.id,last);
    releases.splice(0).forEach(r=>r());await work;
    assert.equal(manager.status(job.id).ready,1);
    assert.equal(manager.status(job.id).status,'idle');
    const cached=manager.prioritize(job.id,last);
    assert.equal(cached.status,'idle');
    assert.equal(calls.length,1);
  } finally {manager.close(); releases.forEach(r=>r()); f.cleanup();}
});
