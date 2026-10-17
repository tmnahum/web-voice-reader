import test from 'node:test';
import assert from 'node:assert/strict';
import {readingProgress, formatReadingTime} from '../web/reading.js';

test('timeline combines saved durations with estimates and follows seeks and playback', () => {
  const chunks = [{start:0,duration:20},{start:60,duration:null},{start:120,duration:30}];
  assert.deepEqual(readingProgress(180,chunks),{current:0,total:70,estimated:true});
  assert.deepEqual(readingProgress(180,chunks,90),{current:30,total:70,estimated:true});
  assert.deepEqual(readingProgress(180,chunks,0,{chunk:2,time:8}),{current:48,total:70,estimated:true});
  chunks[1].duration=25;
  assert.deepEqual(readingProgress(180,chunks,0,{chunk:2,time:8}),{current:53,total:75,estimated:false});
  assert.deepEqual(readingProgress(180,chunks,0,null,true),{current:75,total:75,estimated:false});
  assert.deepEqual(readingProgress(180,null,90),{current:30,total:60,estimated:true});
});

test('timeline formats seconds, minute boundaries, and long recordings', () => {
  assert.equal(formatReadingTime(0),'0:00');
  assert.equal(formatReadingTime(59.9),'0:59');
  assert.equal(formatReadingTime(83),'1:23');
  assert.equal(formatReadingTime(3661),'1:01:01');
});
