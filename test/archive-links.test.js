import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { archiveLinks } from '../web/archive-links.js';

test('archived links navigate locally, support new tabs, and update dynamic links', async () => {
  const dom = new JSDOM('<a href="../next?q=a%26b#snapshot=evil"><span>Next</span></a><a href="#section">Section</a><a href="mailto:a@example.com">Email</a>', {url:'https://archive.example/snapshots/1/original', runScripts:'outside-only'});
  try {
    const paths = [];
    const release = dom.window.eval(`(${archiveLinks.toString()})`)(dom.window.document, 'https://source.example/posts/page', 'https://archive.example', path => paths.push(path));
    const [next, section, email] = dom.window.document.querySelectorAll('a');
    assert.equal(next.href, 'https://archive.example/https://source.example/next?q=a%26b');
    assert.equal(next.target, '_blank');
    assert.equal(section.getAttribute('href'), '#section');
    assert.equal(email.href, 'mailto:a@example.com');
    const click = new dom.window.MouseEvent('click', {bubbles:true, cancelable:true});
    next.firstChild.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(paths, ['/https://source.example/next?q=a%26b']);
    // Cancel default navigation after checking the modifier event reaches the link.
    next.addEventListener('click', event => { assert.equal(event.defaultPrevented, false); event.preventDefault(); });
    next.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true, cancelable:true, ctrlKey:true}));
    assert.equal(paths.length, 1);
    const added = dom.window.document.createElement('a');
    added.href = '//other.example/story';
    dom.window.document.body.append(added);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(added.href, 'https://archive.example/https://other.example/story');
    added.href = '/changed';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(added.href, 'https://archive.example/https://source.example/changed');
    release();
  } finally { dom.window.close(); }
});
