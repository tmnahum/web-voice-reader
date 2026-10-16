"""One-shot Kokoro worker; isolated from the web server environment."""
import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
import sys
import json
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import espeakng_loader
from phonemizer.backend.espeak.wrapper import EspeakWrapper
from kokoro import KModel, KPipeline
from app.timing import kokoro_words

def main():
    request=json.loads(sys.stdin.read())
    path=Path(os.environ['KOKORO_MODELS'])
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    os.environ['ESPEAK_DATA_PATH']=espeakng_loader.get_data_path()
    torch.set_num_threads(4)
    device='cuda' if torch.cuda.is_available() else 'cpu'
    model=KModel(config=str(path/'config.json'),model=str(path/'kokoro-v1_0.pth')).to(device).eval()
    pipeline=KPipeline(lang_code=request['voice'][0],model=model,device=device)
    with torch.no_grad():
        outputs=list(pipeline(request['text'],voice=str(path/'voices'/f"{request['voice']}.pt")))
    audio=np.concatenate([o.audio.detach().cpu().numpy() for o in outputs])
    sf.write(request['output'],audio,24000)
    Path(request['output']+'.json').write_text(json.dumps(kokoro_words(request['text'],outputs)))
if __name__=='__main__': main()
