import asyncio
import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from app.capture import capture, parse_page

ROOT=Path(__file__).resolve().parents[1]
DATA=Path(os.environ.get('VOICESITE_DATA',ROOT/'data'))
DATA.mkdir(parents=True,exist_ok=True)
(DATA/'audio').mkdir(exist_ok=True)
def db():
    conn=sqlite3.connect(DATA/'library.sqlite3'); conn.row_factory=sqlite3.Row; return conn
with db() as conn:
    conn.execute('CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT, created TEXT, document TEXT, snapshot TEXT)')
app=FastAPI(title='Voicesite')
lock=asyncio.Lock()
VOICES={'af_heart':'Heart · American','af_bella':'Bella · American','am_michael':'Michael · American','bf_emma':'Emma · British','bm_george':'George · British'}
CSP="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox"
@app.middleware('http')
async def same_origin(request,call_next):
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin')
        if (origin and urlsplit(origin).netloc != request.headers.get('host')) or request.headers.get('sec-fetch-site')=='cross-site':
            return JSONResponse({'detail':'Cross-origin writes are not allowed.'},status_code=403)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    return response
class CaptureInput(BaseModel):
    url:str=Field(min_length=1,max_length=2048)
class SpeechInput(BaseModel):
    block_id:str
    voice:str='af_heart'
def save(doc,snapshot):
    ident=uuid.uuid4().hex
    created=datetime.now(timezone.utc).isoformat()
    doc.update(id=ident,created=created)
    with db() as conn:
        conn.execute('INSERT INTO pages VALUES (?,?,?,?,?)',(ident,doc['title'],created,json.dumps(doc),snapshot))
    return doc
def get_page(ident):
    with db() as conn: row=conn.execute('SELECT * FROM pages WHERE id=?',(ident,)).fetchone()
    if row is None: raise HTTPException(404,'Page not found.')
    return row
@app.get('/api/pages')
def pages():
    with db() as conn: return [dict(row) for row in conn.execute('SELECT id,title,created FROM pages ORDER BY created DESC')]
@app.get('/api/config')
def config():
    return {'voices':VOICES,'speech_ready':bool(os.environ.get('KOKORO_PYTHON') and os.environ.get('KOKORO_MODELS'))}
@app.post('/api/pages')
async def add_page(data:CaptureInput):
    try: doc,snapshot=await capture(data.url)
    except Exception as exc: raise HTTPException(400,str(exc)) from exc
    if not doc['blocks']: raise HTTPException(400,'No readable text was found. This page may require JavaScript.')
    return save(doc,snapshot)
@app.post('/api/demo')
def demo():
    body=(ROOT/'static/demo.html').read_text()
    tree,doc=parse_page(body,'https://example.com/a-slower-web')
    from lxml import html
    return save(doc,html.tostring(tree,encoding='unicode'))
@app.get('/api/pages/{ident}')
def page(ident:str): return json.loads(get_page(ident)['document'])
@app.get('/api/pages/{ident}/original')
def original(ident:str): return HTMLResponse(get_page(ident)['snapshot'],headers={'Content-Security-Policy':CSP})
@app.post('/api/pages/{ident}/speech')
async def speech(ident:str,data:SpeechInput):
    doc=json.loads(get_page(ident)['document'])
    block=next((b for b in doc['blocks'] if b['id']==data.block_id),None)
    if not block or data.voice not in VOICES: raise HTTPException(400,'Unknown block or voice.')
    python=os.environ.get('KOKORO_PYTHON')
    if not python: raise HTTPException(503,'Set KOKORO_PYTHON and KOKORO_MODELS to enable local speech.')
    if len(block['text'])>12000: raise HTTPException(400,'This text block is too long for this first version.')
    key=hashlib.sha256(('kokoro-v1|'+data.voice+'|'+block['text']).encode()).hexdigest()
    output=DATA/'audio'/f'{key}.wav'
    async with lock:
        if not output.exists() or not Path(str(output)+'.json').exists():
            temp=output.with_suffix('.tmp.wav')
            process=await asyncio.create_subprocess_exec(python,'-m','app.speech',cwd=ROOT,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.PIPE)
            try:
                _,error=await asyncio.wait_for(process.communicate(json.dumps({'text':block['text'],'voice':data.voice,'output':str(temp)}).encode()),180)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                process.kill(); await process.wait(); raise HTTPException(504,'Speech generation timed out.')
            if process.returncode:
                (DATA/'speech-error.log').write_bytes(error)
                raise HTTPException(500,'Kokoro could not generate speech. See data/speech-error.log.')
            temp.replace(output); Path(str(temp)+'.json').replace(str(output)+'.json')
    return {'url':f'/audio/{key}.wav','words':json.loads(Path(str(output)+'.json').read_text())}
app.mount('/audio',StaticFiles(directory=DATA/'audio'),name='audio')
app.mount('/',StaticFiles(directory=ROOT/'static',html=True),name='static')
