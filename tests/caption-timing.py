import io,pathlib,sys
from types import SimpleNamespace as NS
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1] / 'native'))
import av
from PIL import Image, ImageDraw, ImageFont
from screen_captions import original_rows
from precision import phrase_rows
from kaka_host import split_rows
txt=['今天我们来讲秋冬穿搭','先看裤子的版型','最后再说面料']
buf=io.BytesIO()
with av.open(buf,'w',format='mp4') as c:
    st=c.add_stream('mpeg4',rate=10); st.width=560;st.height=340;st.pix_fmt='yuv420p'
    font=ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc',28)
    for i in range(90):
        im=Image.new('RGB',(560,340),'#383f32')
        d=ImageDraw.Draw(im); d.text((280,32),'穿搭频道',font=font,anchor='mt'); d.text((280,252),txt[i//30],font=font,anchor='mt')
        for pkt in st.encode(av.VideoFrame.from_image(im)):c.mux(pkt)
    for pkt in st.encode():c.mux(pkt)
rows=[dict(s=i*3,e=(i+1)*3,t=t) for i,t in enumerate(txt)]
captions=original_rows(buf.getvalue(),rows,9,str,lambda t:None)
print('OCR',captions)
assert [r['t'] for r in captions]==txt
assert all(abs(r['s']-i*3)<.35 for i,r in enumerate(captions))
cue=split_rows([dict(s=.27,e=14.62,t='这个原字幕有原作者打出的标点，保留这行为什么很重要呢？因为这行比二十五个字长。')])['rows'];assert len(cue)==1 and cue[0]['s']==270 and cue[0]['e']==14620
words=[NS(word='先说',start=.2,end=.5),NS(word='原因',start=.52,end=.9),NS(word='再看',start=1.6,end=2.0),NS(word='版型。',start=2.1,end=2.3),NS(word='继续',start=2.31,end=2.6)]
parts=phrase_rows(NS(words=words),str);assert [x['t'] for x in parts]==['先说原因','再看版型。','继续'] and parts[1]['s']==1.6
print('PASS original cue boundaries, measured pauses, punctuation, embedded captions and watermark rejection')

# Animated subtitles sometimes reveal only the start/end while fading in.
from screen_captions import same_display, representative
from collections import Counter
assert same_display('先看裤子的版型','先看裤子')
assert not same_display('先看裤子的版型','最后再说面料')
variants = Counter({'先看裤子':5,'先看裤子的版型':2,'先看褂子的版型':1})
winner = representative({'votes':variants,'s':1,'e':3},lambda t:'先看裤子的版型')
assert winner == '先看裤子的版型'
print('PASS animated prefixes do not replace the complete subtitle')

# Short brand names are especially vulnerable to a homophone in the audio.
# Two matching frames must not lose to one OCR glitch just because ASR agrees
# with that glitch. These cases failed with the previous audio-weighted score.
for correct, wrong in [('始祖鸟','始祖乌'), ('巴塔哥尼亚','巴塔哥尼雅'), ('羊毛衫','杨毛衫')]:
    run = {'votes':Counter({correct:2,wrong:1}),'s':0,'e':1}
    assert representative(run,lambda t:wrong) == correct
print('PASS repeated original captions take priority over ASR homophones')

from screen_captions import clean_display
flicker = [dict(s=0,e=1,t='鞋底厚得像踩砖头'),dict(s=1.3,e=2,t='鞋底厚得像踩砖头'),
           dict(s=2.1,e=3,t='4K GOFPS视觉上把脚拉成一条线')]
clean = clean_display(flicker,lambda t:'鞋底厚得像踩砖头，视觉上把脚拉成一条线')
assert len(clean)==2 and clean[0]['e']==2 and clean[1]['t']=='视觉上把脚拉成一条线'
assert len(clean_display(flicker[:2],lambda t:'鞋底厚得像踩砖头，鞋底厚得像踩砖头'))==2
