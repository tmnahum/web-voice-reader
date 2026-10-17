// Run in a disposable container with the production restrictions before promotion.
import assert from 'node:assert/strict';
import {createBrowserCapture} from '../server/browser-capture.js';
import {createSpeech} from '../server/speech.js';
import {createImageReading} from '../server/image-reading.js';
import {renderEffects} from '../server/effects.js';
import {execFileSync} from 'node:child_process';
const browser = createBrowserCapture({directory:'/tmp/browser-state'});
const page = await browser('https://example.com');
assert.match(page.body.toString(), /Example Domain/);
console.log('Sandboxed browser capture passed.');
const speech = createSpeech();
const images = createImageReading({directory:'/tmp/image-reading'});
try {
  const source = await speech.generate({text:'Container verification.',voice:'af_bella'});
  assert.ok(source.audio && source.duration > 0);
  const result = await renderEffects({source, words:[{text:'Container'},{text:'verification.'}],settings:Object.fromEntries(['italic','caps','link'].map(k=>[k,{enabled:false,pitch:0,gain:0,stretch:1,echo:0}]))});
  assert.ok(result.audio);
  console.log('Speech and effects passed.');
  // Tiny valid PNG exercises decoding/OCR initialization without expensive captioning.
  const image = await images.read('smoke','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
  assert.ok(['decorative','caption','ocr'].includes(image.kind));
  const png = execFileSync('/opt/inference/bin/python', ['-c', "from PIL import Image; import io,base64; b=io.BytesIO(); Image.new('RGB',(128,128),'white').save(b,format='PNG'); print(base64.b64encode(b.getvalue()).decode())"], {encoding:'utf8'}).trim();
  const caption = await images.read('smoke-caption', 'data:image/png;base64,' + png);
  assert.equal(caption.kind, 'caption');
  assert.ok(caption.text);
  console.log('Image worker passed.');
} finally {speech.close(); images.close();}
