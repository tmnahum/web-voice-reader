"""Local-only image inference. Model weights must be provisioned before use."""
import base64
import contextlib
import io
import json
import os
import sys
import warnings

# Keep stdout exclusively for the JSON protocol, including during imports.
protocol = sys.stdout
sys.stdout = sys.stderr
from PIL import Image, ImageOps
import numpy as np
import torch
from rapidocr import RapidOCR, LangRec
from transformers import BlipProcessor, BlipForConditionalGeneration

Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
if os.environ.get('IMAGE_THREADS'):
    torch.set_num_threads(int(os.environ['IMAGE_THREADS']))
ocr = None
processor = None
model = None


def analyze(encoded):
    global ocr, processor, model
    with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
    image.thumbnail((2400, 2400))
    if ocr is None:
        ocr = RapidOCR(params={'Rec.lang_type': LangRec.EN})
    result = ocr(np.asarray(image)[:, :, ::-1].copy())
    lines = []
    area = 0
    if result.txts is not None:
        for box, text, score in zip(result.boxes, result.txts, result.scores):
            if score >= .85 and text.strip():
                lines.append(text.strip())
                area += float((max(box[:, 0]) - min(box[:, 0])) * (max(box[:, 1]) - min(box[:, 1])))
    text = '\n'.join(lines)
    if len(text) > 19500:
        text = text[:19500].rsplit(' ', 1)[0] + ' [Remaining image text omitted.]'
    # Text-dominant images (screenshots, scanned paragraphs, quotations).
    # This intentionally uses OCR confidence/density, not invented model text.
    density = area / (image.width * image.height)
    if (len(text.split()) >= 4 and density >= .06) or (len(lines) >= 3 and len(text) >= 30):
        return {'kind': 'ocr', 'text': text, 'ocrText': text}
    if min(image.size) < 32:
        return {'kind': 'ocr' if text else 'decorative', 'text': text, 'ocrText': text}
    if model is None:
        path = os.environ.get('IMAGE_CAPTION_MODEL', 'models/blip-image-captioning-base')
        processor = BlipProcessor.from_pretrained(path, local_files_only=True)
        model = BlipForConditionalGeneration.from_pretrained(path, local_files_only=True, use_safetensors=False).eval()
    with torch.inference_mode():
        output = model.generate(**processor(images=image, return_tensors='pt'), max_new_tokens=32, num_beams=3)
    caption = processor.decode(output[0], skip_special_tokens=True).strip()
    return {'kind': 'caption', 'text': ' '.join(caption.split()[:25]), 'ocrText': text}


for line in sys.stdin:
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = analyze(json.loads(line)['image'])
    except Exception as error:
        print(str(error), file=sys.stderr)
        result = {'error': 'Local image analysis failed.'}
    print(json.dumps(result), file=protocol, flush=True)
