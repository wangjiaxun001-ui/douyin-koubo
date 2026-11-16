"""Local Mandarin ASR. Times sent to Chrome are seconds in the original audio."""
import base64
import re
from pathlib import Path

MODEL = Path(__file__).resolve().parent / 'models' / 'whisper-small'
END = re.compile(r'[。！？!?；;…][”’」』）)]*$')
PAUSE = re.compile(r'[，、,:：][”’」』）)]*$')


def phrase_rows(segment, convert):
    words = list(segment.words or ())
    if not words:
        text = convert(segment.text.strip())
        return [{'s': segment.start, 'e': segment.end, 't': text}] if text else []
    rows = []
    pieces = []
    for word in words:
        if not word.word:
            continue
        if pieces:
            text = ''.join(pieces).rstrip()
            if word.start - end >= 0.35 or END.search(text) or (len(text) >= 8 and PAUSE.search(text)):
                rows.append({'s': start, 'e': end, 't': convert(text.strip())})
                pieces.clear()
        if not pieces:
            start = word.start
        pieces.append(word.word)
        end = word.end
    if pieces:
        rows.append({'s': start, 'e': end, 't': convert(''.join(pieces).strip())})
    return rows


def transcribe_stream(read, send, terms):
    import numpy as np
    from faster_whisper import WhisperModel
    from opencc import OpenCC

    if not (MODEL / 'model.bin').is_file():
        raise ValueError('本机精校模型尚未安装。')
    model = WhisperModel(str(MODEL), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
    send({'ready': True})
    pcm = bytearray()
    video = bytearray()
    while True:
        msg = read()
        if msg.get('op') == 'finish':
            break
        if msg.get('op') == 'picture':
            chunk = base64.b64decode(msg['data'], validate=True)
            if len(chunk) > 384000 or len(video)+len(chunk)>112*1024*1024:
                raise ValueError('画面数据过大。')
            video.extend(chunk)
            send({'received':True})
            continue
        if msg.get('op') != 'audio':
            raise ValueError('无法读取音轨。')
        chunk = base64.b64decode(msg['pcm'], validate=True)
        if len(chunk) % 2 or not 0 < len(chunk) <= 128000 or len(pcm) + len(chunk) > 16000 * 2 * 1201:
            raise ValueError('音轨长度异常。')
        pcm.extend(chunk)
        send({'received': True})
    audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
    convert = OpenCC('t2s').convert
    segments, _ = model.transcribe(audio, language='zh', word_timestamps=True,
        hotwords=terms[:180] or None, beam_size=3, temperature=0, condition_on_previous_text=False, vad_filter=True,
        vad_parameters={'min_silence_duration_ms':350, 'speech_pad_ms':120})
    speech = []
    for seg in segments:
        rows = phrase_rows(seg, convert)
        if rows:
            speech.extend(rows)
            send({'rows':rows})
    captions = None
    if video and speech:
        send({'checkingPicture':True})
        try:
            from screen_captions import original_rows
            vocabulary = [t.strip() for t in re.split('[、,，;；\n]+',terms) if t.strip()]
            captions = original_rows(video,speech,len(audio)/16000,convert,
                                     lambda t:send({'checkingPicture':True, 'pictureTime':t}),vocabulary)
        except (BrokenPipeError, EOFError):
            raise
        except Exception as error:
            import sys
            print('Picture subtitles unavailable:', type(error).__name__, file=sys.stderr)
    send({'done':True, 'captions':captions})
