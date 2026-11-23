"""Real local OCR regression, with no audio track or speech model available."""
import base64
import io
import pathlib
import sys

import av
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'native'))
from picture_only import extract_picture, picture_stream, choose_band, collapse_runs

sys.modules['faster_whisper']=None
texts=['这件衣服是羊毛','这件衣服不是羊毛','最后看裤子的版型']
buf=io.BytesIO()
with av.open(buf,'w',format='mp4') as c:
    stream=c.add_stream('mpeg4',rate=10)
    stream.width=960;stream.height=540;stream.pix_fmt='yuv420p'
    font=ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc',32)
    for i in range(90):
        image=Image.new('RGB',(960,540),'#31352c')
        draw=ImageDraw.Draw(image)
        draw.text((480,60),'一直显示的中文水印',font=font,anchor='mt')
        draw.text((480,410),texts[i//30],font=font,anchor='mt')
        draw.text((480,475),'English translation stays below',fill='white',anchor='mt')
        for packet in stream.encode(av.VideoFrame.from_image(image)):c.mux(packet)
    for packet in stream.encode():c.mux(packet)
video=buf.getvalue()
result=extract_picture(video,9)
assert [r['t'] for r in result['captions']]==texts,result
assert not result['uncertain'] and not result['gaps'],result
assert all(abs(r['s']-i*3)<.4 for i,r in enumerate(result['captions']))
assert result==extract_picture(video,9),'same frames must give the same result'
try:
    choose_band([[('固定标题',.8,.04)]]*20)
except ValueError:
    pass
else:
    raise AssertionError('static title mistaken for transcript')
messages=iter([{'op':'picture','data':base64.b64encode(video[i:i+384000]).decode()}
               for i in range(0,len(video),384000)]+[{'op':'finish'}])
sent=[]
picture_stream(lambda:next(messages),sent.append,9)
assert sent[0]=={'ready':True,'pictureOnly':True}
assert sent[-1]['done'] and sent[-1]['captions']==result['captions']
assert not any('rows' in m for m in sent),'must display only the completed transcript'
try:
    picture_stream(lambda:{'op':'audio','pcm':'AAA='},lambda m:None,9)
except ValueError:
    pass
else:
    raise AssertionError('picture-only mode accepted audio')
print('PASS bilingual video OCR, static watermark rejection, consecutive similar lines, repeatability and native protocol without ASR')

# A lower-confidence second opinion must not replace an existing visual reading.
import picture_only
from picture_only import review_uncertain
actual_reader=picture_only.CaptionReader
class WeakSecondOpinion:
    def __init__(self,accurate=False):pass
    def read(self,image):return [('洋毛',.5,.5,.90)]
try:
    picture_only.CaptionReader=WeakSecondOpinion
    reviewed=review_uncertain(video,[{'s':0,'e':2,'t':'羊毛','n':10,'uncertain':True}],.8,.08,9,lambda t:None)
    assert reviewed[0]['t']=='羊毛' and reviewed[0]['uncertain']
finally:
    picture_only.CaptionReader=actual_reader
print('PASS weak review cannot overwrite the original visual reading')
