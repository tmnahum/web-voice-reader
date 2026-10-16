"""Static page capture and a source-linked reading list. No article-only filtering."""
import asyncio
import base64
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlsplit
import httpx
from lxml import html, etree

async def public_address(url):
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.port not in (None, 80, 443):
        raise ValueError('Use a public HTTP or HTTPS URL on a standard port.')
    entries = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, p.hostname, p.port or (443 if p.scheme == 'https' else 80), type=socket.SOCK_STREAM), 10)
    ips = [e[4][0] for e in entries]
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise ValueError('Local and private network addresses cannot be captured.')
    return ips[0]

async def fetch(url, limit=4_000_000):
    async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
        for _ in range(6):
            ip = await public_address(url)
            target = httpx.URL(url)
            async with client.stream('GET', target.copy_with(host=ip), headers={'Host': target.netloc.decode(), 'User-Agent': 'Voicesite/0.1'}, extensions={'sni_hostname': target.host}) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get('location', ''))
                    continue
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > limit:
                        raise ValueError('Resource exceeds the capture size limit.')
                return bytes(body), response.headers.get('content-type', ''), url
    raise ValueError('Too many redirects.')

COMMENT = re.compile(r'(^|[\s_-])(comments?|replies|reply|discussion)([\s_-]|$)', re.I)
BLOCK = {'p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','figcaption','td','th','dt','dd'}

def parse_page(body, url):
    tree = html.document_fromstring(body)
    title = tree.findtext('.//title') or urlsplit(url).hostname or 'Saved page'
    for el in list(tree.iter()):
        if not isinstance(el.tag, str):
            continue
        if el.tag in ('script','iframe','object','embed','base','form','noscript','meta'):
            el.drop_tree()
            continue
        for key in list(el.attrib):
            if key.lower().startswith('on') or key in ('srcdoc','action','formaction','ping','autofocus'):
                del el.attrib[key]
        if el.tag == 'a':
            href = urljoin(url, el.get('href', ''))
            el.set('href', href if urlsplit(href).scheme in ('http','https','mailto') else '#')
            el.set('target', '_blank')
            el.set('rel', 'noopener noreferrer')
        if el.tag == 'img':
            el.set('src', urljoin(url, el.get('src', '')))
            for key in ('srcset','loading'):
                el.attrib.pop(key, None)
    blocks = []
    root = tree.find('body')
    if root is None:
        root = tree
    # Text runs include author names and bare DIV text, not only paragraphs.
    def walk(el, section='article', depth=0):
        if not isinstance(el.tag, str) or el.tag in ('style','link','head') or el.get('hidden') is not None or el.get('aria-hidden') == 'true':
            return
        marker = ' '.join([el.get('id',''), el.get('class',''), el.get('itemprop','')])
        is_comment = bool(COMMENT.search(marker))
        if is_comment:
            section = 'comments'
            depth += 1
        elif el.tag in ('nav','footer','aside') and section != 'comments':
            section = 'other'
        def add(text, kind='paragraph', links=None):
            text = re.sub(r'\s+', ' ', text or '').strip()
            if not text and kind != 'image':
                return
            bid = f'b{len(blocks)}'
            # Multiple text runs can share an original element anchor.
            anchor = el.get('data-voice-id') or bid
            el.set('data-voice-id', anchor)
            el.set('id', el.get('id') or anchor)
            blocks.append({'id':bid, 'anchor':el.get('id'), 'kind':kind, 'text':text, 'section':section, 'depth':max(0,depth-1), 'links':links or [], 'src':el.get('src') if kind=='image' else None})
        if el.tag == 'img':
            add(el.get('alt') or 'Image. Description not available yet.', 'image')
            return
        has_block = any(isinstance(c.tag,str) and (c.tag in BLOCK or c.tag in ('div','section','article','img','ul','ol')) for c in el.iterdescendants())
        if el.tag in BLOCK and not has_block:
            text = re.sub(r'\s+', ' ', el.text_content()).strip()
            links=[]
            # Calculate exact offsets from text nodes, including repeated link text.
            parts=[]
            def inline(n, href=None):
                href = n.get('href') if n.tag=='a' else href
                if n.text: parts.append((n.text,href))
                for child in n:
                    inline(child,href)
                    if child.tail: parts.append((child.tail,href))
            inline(el)
            raw=''; spans=[]
            for value, href in parts:
                start=len(raw); raw+=value
                if href: spans.append((start,len(raw),href))
            text=re.sub(r'\s+',' ',raw).strip()
            for start,end,href in spans:
                a=len(re.sub(r'\s+',' ',raw[:start]).lstrip())
                b=len(re.sub(r'\s+',' ',raw[:end]).lstrip())
                if b>a: links.append({'start':a,'end':min(b,len(text)),'href':href})
            add(text, 'heading' if el.tag.startswith('h') and len(el.tag)==2 else 'paragraph', links)
            return
        add(el.text)
        for child in el:
            walk(child,section,depth)
            add(child.tail)
    walk(root)
    return tree, {'title':title.strip(), 'url':url, 'blocks':blocks, 'capture_note':'Static capture: includes comments present in the returned HTML. Hidden, embedded, and “load more” comments may be missing. Image descriptions and OCR are not enabled yet.'}

async def capture(url):
    body, mime, final_url = await fetch(url)
    if 'html' not in mime:
        raise ValueError('This URL does not return an HTML page.')
    tree, doc = parse_page(body,final_url)
    # Store common images and styles with the snapshot. Never load remote assets during replay.
    assets=tree.xpath('//img[@src] | //link[contains(@rel,"stylesheet")][@href]')
    missed=max(0,len(assets)-40)
    semaphore=asyncio.Semaphore(4)
    async def save(el):
        nonlocal missed
        try:
            async with semaphore:
                src=urljoin(final_url,el.get('src') or el.get('href'))
                data,mime,_=await fetch(src,2_000_000)
            if el.tag=='img' and mime.startswith('image/'):
                el.set('src','data:'+mime.split(';')[0]+';base64,'+base64.b64encode(data).decode())
            elif el.tag=='link' and 'text/css' in mime:
                style=etree.Element('style'); style.text=data.decode('utf-8',errors='replace'); el.getparent().replace(el,style)
            else: missed+=1
        except Exception:
            missed+=1
    await asyncio.gather(*(save(el) for el in assets[:40]))
    for block in doc['blocks']:
        if block['kind']=='image':
            nodes=tree.xpath('//*[@data-voice-id=$id]',id=block['id'])
            if nodes and nodes[0].get('src','').startswith('data:image/'):
                block['src']=nodes[0].get('src')
            else: block['src']=None
    doc['capture_note'] += ' External fonts, CSS background images, and scripts are not archived in this first version.'
    if missed: doc['capture_note'] += f' {missed} image/style resources were not saved.'
    return doc, html.tostring(tree,encoding='unicode')
