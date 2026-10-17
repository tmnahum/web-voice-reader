// Run in a disposable container with the production restrictions before promotion.
import assert from 'node:assert/strict';
import {createBrowserCapture, virtualDisplay} from '../server/browser-capture.js';
import {inspectRenderedPage,serializeRenderedPage} from '../server/page-readiness.js';
import {createDesktopPool} from '../server/desktop-browser.js';
import {createBrowserProxy} from '../server/browser-proxy.js';
import {createSpeech} from '../server/speech.js';
import {createImageReading} from '../server/image-reading.js';
import {renderEffects} from '../server/effects.js';
import {execFileSync} from 'node:child_process';
const browser = createBrowserCapture({directory:'/tmp/browser-state'});
const page = await browser('https://example.com');
assert.match(page.body.toString(), /Example Domain/);
await browser.close();
console.log('Sandboxed browser capture passed.');
const desktops = createDesktopPool({directory:'/tmp/desktop-check', createDisplay:virtualDisplay, createProxy:createBrowserProxy});
try {
  const session = await desktops.acquire('https://example.com', 'example');
  await session.page.setContent(`<button style="position:absolute;left:100px;top:100px;width:200px;height:100px" onclick="this.textContent='clicked'">Test input</button>`);
  const {width,height} = session.page.captureViewport;
  assert.ok(width >= 1278 && width <= 1280 && height >= 898 && height <= 900);
  assert.deepEqual(await session.page.evaluate(() => [innerWidth,innerHeight]), [width,height]);
  await session.page.nativeInput({type:'down',x:150,y:150});
  await session.page.nativeInput({type:'up',x:150,y:150});
  await session.page.waitForFunction(() => document.querySelector('button').textContent === 'clicked');
  await session.page.setContent('<main>Loading...</main><script>setTimeout(() => {document.querySelector("main").textContent="The delayed article is now loaded and ready to archive."},250)</script>');
  assert.equal((await session.page.evaluate(inspectRenderedPage)).ready,false);
  await session.page.waitForFunction(() => document.querySelector('main').textContent.startsWith('The delayed'));
  assert.equal((await session.page.evaluate(inspectRenderedPage)).ready,true);
  const frozen = await session.page.evaluate(serializeRenderedPage);
  assert.match(frozen,/The delayed article/);
  assert.doesNotMatch(frozen,/<script/);
  const screenshot = await session.page.screenshot();
  assert.ok(screenshot.length > 100);
  await session.context.addCookies([{name:'desktop-check',value:'retained',url:'https://example.com',expires:Math.floor(Date.now()/1000)+3600}]);
  await desktops.release(session);
  assert.equal(await desktops.acquire('https://example.com', 'example'), session);
  await desktops.close();
  const reopened = await desktops.acquire('https://example.com', 'example');
  assert.ok((await reopened.context.cookies('https://example.com')).some(c => c.name === 'desktop-check' && c.value === 'retained'));
  console.log('Native desktop input, viewport, reuse, and profile persistence passed.');
} finally {await desktops.close();}
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
