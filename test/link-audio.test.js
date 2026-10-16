import test from 'node:test';
import assert from 'node:assert/strict';
import { addLinkEcho } from '../web/link-audio.js';

function wav() {
  const bytes = new Uint8Array(44 + 2000), view = new DataView(bytes.buffer);
  const tag = (at, value) => bytes.set(new TextEncoder().encode(value), at);
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 1000, true);
  view.setUint32(28, 2000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, 2000, true);
  for (const frame of [50, 150, 550]) view.setInt16(44 + frame * 2, 10000, true);
  return bytes;
}

test('echo affects only linked speech, preserves WAV timing and leaves cached bytes intact', () => {
  const bytes = wav(), saved = bytes.slice();
  const result = addLinkEcho(bytes, [{index:0,start:.1,end:.3}, {index:1,start:.3,end:.5}], [{}, {link:true}, {link:true}], 1);
  const view = new DataView(result.buffer);
  assert.equal(result.length, bytes.length);
  assert.deepEqual(result.subarray(0, 44 + 100 * 2), bytes.subarray(0, 44 + 100 * 2));
  assert.deepEqual(result.subarray(44 + 500 * 2), bytes.subarray(44 + 500 * 2));
  assert.equal(view.getInt16(44 + 185 * 2, true), 2200);
  assert.equal(view.getInt16(44 + 215 * 2, true), 1400);
  assert.equal(view.getInt16(44 + 250 * 2, true), 900);
  assert.deepEqual(bytes, saved);
});

test('plain speech and unsupported audio pass through unchanged', () => {
  const bytes = wav();
  assert.equal(addLinkEcho(bytes, [{index:0,start:0,end:1}], [{}]), bytes);
  const invalid = new Uint8Array(44);
  assert.equal(addLinkEcho(invalid, [{index:0,start:0,end:1}], [{link:true}]), invalid);
});
