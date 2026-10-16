import asyncio
import importlib
import json
import socket
import pytest
from fastapi.testclient import TestClient
from lxml import html
from app.capture import parse_page, public_address

def test_comments_replies_links_and_authors_survive():
    tree,doc=parse_page('''<html><head><title>Test</title></head><body><article><p>See <a href="/x">this</a> and <a href="/y">this</a>.</p></article><section id="comments"><strong>Maya</strong><p>Hello!</p><div class="reply"><b>Jon</b><p>A reply.</p></div></section></body></html>''','https://example.com')
    texts=[b['text'] for b in doc['blocks']]
    assert texts==['See this and this.','Maya','Hello!','Jon','A reply.']
    paragraph=doc['blocks'][0]
    assert [(paragraph['text'][l['start']:l['end']],l['href']) for l in paragraph['links']]==[('this','https://example.com/x'),('this','https://example.com/y')]
    assert all(b['section']=='comments' for b in doc['blocks'][1:])
    assert doc['blocks'][-1]['depth']>doc['blocks'][1]['depth']
    assert all(tree.xpath('//*[@id=$anchor]',anchor=b['anchor']) for b in doc['blocks'])

def test_capture_removes_active_content():
    tree,doc=parse_page('<html><head><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body onload="evil()"><script>evil()</script><iframe src="http://localhost"></iframe><p>Safe <a href="javascript:evil()" onclick="evil()">text</a></p></body></html>','https://example.com')
    assert not tree.xpath('//script|//iframe|//meta|//*[@onload]|//*[@onclick]')
    assert tree.xpath('//a')[0].get('href')=='#'
    assert doc['blocks'][0]['text']=='Safe text'

@pytest.mark.parametrize('url',['file:///etc/passwd','http://localhost:8000','http://user:pass@example.com','http://127.0.0.1','http://[::1]','http://169.254.169.254'])
def test_private_urls_rejected(url):
    with pytest.raises(ValueError): asyncio.run(public_address(url))

def test_mixed_dns_rejected(monkeypatch):
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**kw:[(2,1,6,'',('93.184.216.34',80)),(2,1,6,'',('127.0.0.1',80))])
    with pytest.raises(ValueError): asyncio.run(public_address('https://example.com'))

def test_library_snapshot_and_validation(tmp_path,monkeypatch):
    monkeypatch.setenv('VOICESITE_DATA',str(tmp_path))
    import app.main
    main=importlib.reload(app.main)
    with TestClient(main.app) as client:
        assert client.get('/api/pages').json()==[]
        saved=client.post('/api/demo').json()
        ident=saved['id']
        assert any(b['section']=='comments' for b in saved['blocks'])
        assert client.get('/api/pages/'+ident).json()['title']==saved['title']
        response=client.get('/api/pages/'+ident+'/original')
        assert "default-src 'none'" in response.headers['content-security-policy']
        assert 'sandbox' in response.headers['content-security-policy']
        assert client.post('/api/demo',headers={'origin':'https://unrelated.example'}).status_code==403
        assert client.post('/api/pages/'+ident+'/speech',json={'block_id':'b0','voice':'other-family'}).status_code==400
        assert client.get('/api/pages/missing').status_code==404
        assert client.get('/api/pages').json()[0]['id']==ident
