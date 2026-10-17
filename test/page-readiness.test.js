import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {needsRendering, inspectRenderedPage, serializeRenderedPage} from '../server/page-readiness.js';
import {createPageFetcher} from '../server/browser-capture.js';
import {capture} from '../server/capture.js';

const response = (html,url='https://example.com/') => ({url,type:'text/html',body:Buffer.from(html)});
test('automatic capture renders successful HTTP loading shells and Reddit, but keeps ordinary HTML fast', async () => {
  const article = response('<h1>A small useful page</h1><p>No JavaScript needed.</p>');
  const shell = response('<title>Reddit</title><div id="root"><svg></svg></div><script src="app.js"></script>');
  assert.equal(needsRendering(article),false);
  assert.equal(needsRendering(shell),true);
  let calls = 0;
  const browser = async () => {calls++; return article;};
  const fetch = createPageFetcher({fetcher:async () => shell,browser});
  assert.equal(await fetch(shell.url),article);
  assert.equal(calls,1);
  assert.equal(await fetch(shell.url,undefined,'html'),shell);
  assert.equal(calls,1);
  await fetch(shell.url,undefined,'browser');
  assert.equal(calls,2);
  assert.equal(needsRendering(response('<h1>Reddit</h1>','https://www.reddit.com/r/test/')),true);
});

test('Reddit readiness requires a loaded post rather than navigation, a spinner, or a block page', () => {
  const dom = new JSDOM('<main>Loading...</main>',{url:'https://www.reddit.com/r/test/comments/123/title/',runScripts:'outside-only'});
  try {
    const win = dom.window;
    Object.defineProperty(win.document,'readyState',{value:'complete'});
    const inspect = win.eval(`(${inspectRenderedPage.toString()})`);
    Object.defineProperty(win.document.body,'innerText',{get:() => win.document.body.textContent});
    const main = win.document.querySelector('main');
    Object.defineProperty(main,'innerText',{get:() => main.textContent});
    assert.equal(inspect().ready,false);
    main.textContent = "You've been blocked by network security";
    assert.equal(inspect().blocked,true);
    const post = win.document.createElement('shreddit-post');
    post.textContent = 'A real post title with loaded content and comments.';
    Object.defineProperty(post,'innerText',{get:() => post.textContent});
    main.replaceChildren(post);
    assert.equal(inspect().ready,true);
  } finally {dom.window.close();}
});

test('rendered snapshots preserve composed shadow content and remove rehydration scripts', () => {
  const dom = new JSDOM('<title>Loaded page</title><main><post-card><p slot="body">The loaded post text.</p></post-card></main><script>resetToSpinner()</script>',{url:'https://example.com/',runScripts:'outside-only'});
  try {
    const host = dom.window.document.querySelector('post-card');
    host.attachShadow({mode:'open'}).innerHTML = '<style>p{color:red}</style><h1>Rendered title</h1><slot name="body"></slot><button onclick="resetToSpinner()">Reply</button>';
    const html = dom.window.eval(`(${serializeRenderedPage.toString()})`)();
    assert.match(html,/Rendered title/);
    assert.match(html,/The loaded post text/);
    assert.doesNotMatch(html,/<script|onclick|<slot|resetToSpinner/);
    assert.equal((html.match(/The loaded post text/g) || []).length,1);
  } finally {dom.window.close();}
});

test('empty and loading-only pages are not archived; no-script captures retain content without source code', async () => {
  await assert.rejects(capture('https://example.com/',async () => response('<title>Reddit</title><svg></svg><script src="app.js"></script>')),/no readable content/);
  const fetcher = async url => {
    if (url !== 'https://example.com/') throw new Error('No assets');
    return response('<title>Article</title><p>Useful saved content.</p><script>reset()</script><button onclick="reset()">Reply</button>');
  };
  const doc = await capture('https://example.com/',fetcher,{mode:'html'});
  assert.equal(doc.scriptsDisabled,true);
  assert.match(doc.text,/Useful saved content/);
  assert.doesNotMatch(doc.originalHtml,/<script|onclick/);
});

test('repeated shadow styles are shared instead of expanding every element', () => {
  const dom = new JSDOM('<main><post-card></post-card></main>',{url:'https://example.com/',runScripts:'outside-only'});
  try {
    dom.window.document.querySelector('post-card').attachShadow({mode:'open'}).innerHTML =
      Array.from({length:1000},() => '<p>Repeated comment</p>').join('');
    const html = dom.window.eval(`(${serializeRenderedPage.toString()})`)();
    assert.equal((html.match(/Repeated comment/g) || []).length,1000);
    assert.ok(Buffer.byteLength(html) < 120000, 'shared styles should keep repeated content compact');
    assert.ok((html.match(/font-family:/g) || []).length < 5);
  } finally {dom.window.close();}
});

test('main page captures have no default HTML size ceiling in any mode', async () => {
  const large = response('<p>' + 'A readable sentence. '.repeat(260000) + '</p>');
  assert.ok(large.body.length > 5_000_000);
  const seen = [];
  const fetcher = async (_url, limit) => {seen.push(limit); return large;};
  const fetch = createPageFetcher({fetcher,browser:fetcher});
  for (const mode of ['html','browser','auto']) assert.equal(await fetch(large.url,undefined,mode),large);
  assert.deepEqual(seen,[Infinity,Infinity,Infinity]);
});
