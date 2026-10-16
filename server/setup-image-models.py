"""Download model weights once; no page images are sent to these services."""
from huggingface_hub import snapshot_download
from rapidocr import RapidOCR, LangRec
import numpy as np
snapshot_download('Salesforce/blip-image-captioning-base', local_dir='models/blip-image-captioning-base', allow_patterns=['*.json', '*.txt', 'pytorch_model.bin'])
from PIL import Image, ImageDraw
image = Image.new('RGB', (320, 80), 'white')
ImageDraw.Draw(image).text((20, 20), 'Local image reading setup', fill='black')
RapidOCR(params={'Rec.lang_type': LangRec.EN})(np.asarray(image))
