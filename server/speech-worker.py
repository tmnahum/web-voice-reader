"""Persistent local Kokoro worker; stdout contains JSON lines only."""
import base64, io, json, math, os, re, sys
from pathlib import Path
protocol = sys.stdout
sys.stdout = sys.stderr
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
import numpy as np
import soundfile as sf
import torch
import espeakng_loader
from phonemizer.backend.espeak.wrapper import EspeakWrapper
EspeakWrapper.set_library(espeakng_loader.get_library_path())
os.environ['ESPEAK_DATA_PATH'] = espeakng_loader.get_data_path()
from kokoro import KModel, KPipeline
torch.set_num_threads(4)
path = Path(os.environ['KOKORO_MODELS'])
model = KModel(config=str(path / 'config.json'), model=str(path / 'kokoro-v1_0.pth')).to('cpu').eval()
pipeline = KPipeline(lang_code='a', model=model, device='cpu')
for line in sys.stdin:
    try:
        request = json.loads(line)
        text = request['text']
        spans = list(re.finditer(r'\S+', text))
        timings, parts, cursor, offset = {}, [], 0, 0.0
        with torch.no_grad():
            for result in pipeline(text, voice=str(path / 'voices' / (request['voice'] + '.pt')), speed=1):
                samples = result.audio.detach().cpu().numpy()
                duration = len(samples) / 24000
                for token in result.tokens or []:
                    pos = text.find(token.text, cursor) if token.text else -1
                    if pos < 0:
                        continue
                    cursor = pos + len(token.text)
                    a, b = token.start_ts, token.end_ts
                    if a is None or b is None or not all(math.isfinite(t) for t in (a, b)):
                        continue
                    for i, span in enumerate(spans):
                        if span.start() < cursor and span.end() > pos:
                            start, end = offset + max(0, a), offset + min(duration, b)
                            old = timings.get(i)
                            timings[i] = {'index': i, 'start': min(old['start'], start) if old else start, 'end': max(old['end'], end) if old else end}
                parts.append(samples)
                offset += duration
        if not parts:
            raise ValueError('No speech was generated for this text.')
        output = io.BytesIO()
        sf.write(output, np.concatenate(parts), 24000, format='WAV', subtype='PCM_16')
        response = {'audio': base64.b64encode(output.getvalue()).decode(), 'duration': offset, 'words': list(timings.values())}
    except Exception as error:
        response = {'error': str(error)}
    protocol.write(json.dumps(response) + '\n')
    protocol.flush()
