"""Render a whole speech clip with continuous pitch/duration tiers and mapped timings."""
import base64
import io
import json
import sys
import wave
import numpy as np
import parselmouth
from parselmouth.praat import call


def envelope(t, start, end, fade=.025):
    return np.clip(np.minimum((t-start)/min(fade, (end-start)/2), (end-t)/min(fade, (end-start)/2)), 0, 1)


def process(request):
    source = request['source']
    raw = base64.b64decode(source['audio'])
    with wave.open(io.BytesIO(raw)) as wav:
        rate = wav.getframerate()
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError('Effects require mono 16-bit WAV speech.')
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(float)/32768
    duration = len(samples)/rate
    spans = []
    for w in source['words']:
        if not 0 <= w['index'] < len(request['words']):
            continue
        start, end = max(0, w['start']), min(duration, w['end'])
        if end <= start:
            continue
        flags = request['words'][w['index']]
        active = [request['settings'][kind] for kind in ('italic', 'caps', 'link') if flags.get(kind) and request['settings'][kind]['enabled']]
        if active:
            spans.append((start, end, {
                'pitch': max(-4, min(4, sum(s['pitch'] for s in active))),
                'gain': max(-6, min(6, sum(s['gain'] for s in active))),
                'stretch': max(s['stretch'] for s in active),
                'echo': max(s['echo'] for s in active),
            }))
    if not any(s['pitch'] or s['gain'] or s['echo'] or s['stretch'] != 1 for _, _, s in spans):
        return source
    # Duration changes are linear ramps at word edges. Integrate this exact tier
    # to map every timestamp, including plain words after a stretched word.
    points = {0.0: 1.0, duration: 1.0}
    for start, end, s in spans:
        if s['stretch'] == 1:
            continue
        fade = min(.025, (end-start)/3)
        points.update({start: 1.0, start+fade: s['stretch'], end-fade: s['stretch'], end: 1.0})
    times = np.array(sorted(points))
    factors = np.array([points[t] for t in times])
    areas = np.concatenate(([0.0], np.cumsum(np.diff(times)*(factors[:-1]+factors[1:])/2)))

    def mapped(t):
        t = np.clip(t, 0, duration)
        i = np.minimum(np.searchsorted(times, t, side='right')-1, len(times)-2)
        dt = t-times[i]
        slope = (factors[i+1]-factors[i])/(times[i+1]-times[i])
        return areas[i]+factors[i]*dt+slope*dt*dt/2

    pitch_or_time = any(s['pitch'] or s['stretch'] != 1 for _, _, s in spans)
    output = samples.copy()
    if pitch_or_time:
        sound = parselmouth.Sound(samples, sampling_frequency=rate)
        manipulation = call(sound, 'To Manipulation', .005, 60, 600)
        original = call(manipulation, 'Extract pitch tier')
        tier = call('Create PitchTier', 'effects', 0, duration)
        for i in range(1, call(original, 'Get number of points')+1):
            t = call(original, 'Get time from index', i)
            frequency = call(original, 'Get value at index', i)
            shift = 0
            for start, end, s in spans:
                if start < t < end:
                    # Smooth arch over existing intonation; no vibrato or pitch flattening.
                    shift = s['pitch'] * np.sin(np.pi*(t-start)/(end-start))**2
                    break
            call(tier, 'Add point', t, frequency*2**(shift/12))
        call([tier, manipulation], 'Replace pitch tier')
        dtier = call('Create DurationTier', 'timing', 0, duration)
        for t, factor in zip(times, factors):
            call(dtier, 'Add point', float(t), float(factor))
        call([dtier, manipulation], 'Replace duration tier')
        output = call(manipulation, 'Get resynthesis (overlap-add)').values[0].copy()
    expected = round(float(mapped(duration))*rate)
    output = np.pad(output, (0, max(0, expected-len(output))))[:expected]
    timeline = np.arange(len(output))/rate
    gains = np.zeros(len(output))
    for start, end, s in spans:
        a, b = float(mapped(start)), float(mapped(end))
        gains = np.maximum(gains, envelope(timeline, a, b)*max(0, s['gain'])) + envelope(timeline, a, b)*min(0, s['gain'])
    output *= 10**(gains/20)
    dry = output.copy()
    for start, end, s in spans:
        if not s['echo']:
            continue
        a, b = float(mapped(start)), float(mapped(end))
        mask = envelope(timeline, a, b)
        # Source-gated reflections can decay beyond the word, avoiding a cut-off tail.
        signal = dry*mask
        for delay, weight in ((.035, .5), (.065, .3), (.100, .2)):
            n = round(delay*rate)
            if n < len(output):
                output[n:] += signal[:-n]*s['echo']*weight
    # Smooth peak limiting only above -1 dBFS; ordinary speech is untouched.
    ceiling = 10**(-1/20)
    magnitude = np.abs(output)
    over = magnitude > ceiling
    output[over] = np.sign(output[over])*(ceiling+(1-ceiling)*np.tanh((magnitude[over]-ceiling)/(1-ceiling)))
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(np.round(np.clip(output, -1, 1)*32767).astype('<i2').tobytes())
    timings = [{**w, 'start': float(mapped(w['start'])), 'end': float(mapped(w['end']))} for w in source['words']]
    return {'audio': base64.b64encode(buffer.getvalue()).decode(), 'words': timings, 'duration': len(output)/rate}


if __name__ == '__main__':
    try:
        print(json.dumps(process(json.load(sys.stdin))))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
