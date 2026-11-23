"""Extract burned-in Chinese subtitles without ASR or generated corrections."""
import base64
import io
import difflib
import math
import re
import statistics
from collections import Counter
from contextlib import closing
from pathlib import Path

import av
from screen_captions import read_frame

MAX_VIDEO_BYTES = 512 * 1024 * 1024
STEP = .20


def chinese(text):
    return len(re.findall(r'[\u3400-\u9fff]', text))


def visual_key(text):
    # Match punctuation variants while preserving the selected original text.
    return ''.join(re.findall(r'[a-z0-9\u3400-\u9fff]', text.lower()))


def choose_band(samples):
    """Find a recurring position containing changing Chinese lines, not a logo."""
    hits = [(i, text, y, h) for i, lines in enumerate(samples)
            for text, y, h in lines if chinese(text) >= 2 and .15 <= y <= .96]
    choices = []
    for _, _, y, h in hits:
        cluster = [x for x in hits if abs(x[2]-y) < max(.018, min(.035, h*.65))]
        frames = len({x[0] for x in cluster})
        distinct = len({visual_key(x[1]) for x in cluster})
        if frames < 3 or distinct < 3:
            continue
        # Long-lived branding cannot win simply by occurring in every frame.
        counts = Counter(visual_key(x[1]) for x in cluster)
        changing = sum(min(n, 2) for n in counts.values())
        score = changing + distinct * 2 + frames*.2
        choices.append((score, cluster))
    if not choices:
        raise ValueError('没有找到持续变化的中文字幕区域。未改用语音听写。')
    _, cluster = max(choices, key=lambda x:x[0])
    return statistics.median(x[2] for x in cluster), statistics.median(x[3] for x in cluster)


def similarity(a, b):
    a, b = visual_key(a), visual_key(b)
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def collapse_runs(runs):
    """Vote across adjacent frames, retaining sustained changes such as 是/不是."""
    exact = []
    for r in runs:
        if exact and r['s']-exact[-1]['e'] < STEP*1.6 and visual_key(r['t']) == visual_key(exact[-1]['t']):
            previous=exact[-1]
            if r.get('best_score',r.get('score',1))>previous.get('best_score',previous.get('score',1)):
                previous['t']=r['t']
            previous['score']=(previous.get('score',1)*previous['n']+r.get('score',1)*r['n'])/(previous['n']+r['n'])
            previous['best_score']=max(previous.get('best_score',0),r.get('best_score',r.get('score',1)))
            previous['e']=r['e']; previous['n']+=r['n']
        else:
            exact.append(dict(r))
    groups = []
    def winner(group):
        votes = Counter()
        for r in group:
            votes[visual_key(r['t'])] += r['n']
        key = votes.most_common(1)[0][0]
        return max((r for r in group if visual_key(r['t']) == key), key=lambda r:r['n'])['t']
    for r in exact:
        if groups:
            g = groups[-1]; text = winner(g)
            nearby = r['s']-g[-1]['e'] < STEP*2
            similar = similarity(text,r['t']) >= .65
            sustained_change = r['n'] >= 3 and any(x['n'] >= 3 for x in g) and visual_key(text) != visual_key(r['t'])
            if nearby and similar and not sustained_change:
                g.append(r); continue
        groups.append([r])
    # Ignore a brief transition/background misread between the same subtitle.
    i = 1
    while i < len(groups)-1:
        previous, middle, following = groups[i-1:i+2]
        if (following[0]['s']-previous[-1]['e'] <= 1 and
            sum(r['n'] for r in middle) <= 3 and
            visual_key(winner(previous)) == visual_key(winner(following))):
            groups[i-1:i+2] = [previous+middle+following]
        else:
            i += 1
    result = []
    for group in groups:
        text = winner(group)
        support = sum(r['n'] for r in group if visual_key(r['t']) == visual_key(text))
        total = sum(r['n'] for r in group)
        if support < 2 and len(visual_key(text)) < 2:
            continue
        quality=sum(r.get('score',1)*r['n'] for r in group if visual_key(r['t'])==visual_key(text))/support
        row = {'s':group[0]['s'],'e':group[-1]['e'],'t':text,'n':support,'score':quality,
               'uncertain':support < 2 or support/total < .55 or quality < .985}
        if result and row['s']-result[-1]['e'] < STEP*2 and visual_key(text)==visual_key(result[-1]['t']):
            result[-1]['e']=row['e'];result[-1]['n']+=support
            result[-1]['uncertain'] &= row['uncertain']
        else:
            result.append(row)
    return result


class CaptionReader:
    """Local Chinese OCR; model paths are pinned and never downloaded per job."""
    def __init__(self, accurate=False):
        import rapidocr
        from rapidocr import RapidOCR, ModelType
        models = Path(rapidocr.__file__).resolve().parent/'models'
        det, rec = models/'PP-OCRv6_det_small.onnx', models/('PP-OCRv6_rec_medium.onnx' if accurate else 'PP-OCRv6_rec_small.onnx')
        if not det.is_file() or not rec.is_file():
            raise ValueError('请运行 native/install_picture.py 安装本机画面识别模型后重试。')
        self.engine = RapidOCR(params={
            'Global.use_cls':False, 'Global.log_level':'error',
            'Det.model_path':str(det), 'Rec.model_path':str(rec), 'Rec.model_type':ModelType.MEDIUM if accurate else ModelType.SMALL,
            'Det.limit_type':'max', 'Det.limit_side_len':1280,
            'EngineConfig.onnxruntime.intra_op_num_threads':2,
            'EngineConfig.onnxruntime.inter_op_num_threads':1,
        })

    def read(self, image):
        result = self.engine(image)
        if result.txts is None:
            return []
        hits = []
        for text, box, score in zip(result.txts, result.boxes, result.scores):
            ys = [float(p[1])/image.height for p in box]
            xs = [float(p[0])/image.width for p in box]
            hits.append((text,(min(ys)+max(ys))/2,max(ys)-min(ys),min(xs),float(score),max(xs)))
        # Join split Chinese/Latin pieces on one baseline, excluding smaller overlays.
        groups=[]
        for hit in sorted(hits,key=lambda h:h[3]):
            for g in groups:
                prev=g[-1]
                if hit[3]-prev[5] < .08 and abs(hit[1]-prev[1])<min(hit[2],prev[2])*.4 and min(hit[2],prev[2])/max(hit[2],prev[2])>.65:
                    g.append(hit);break
            else:groups.append([hit])
        return [(''.join(x[0] for x in g),statistics.median(x[1] for x in g),
                 max(x[2] for x in g),min(x[4] for x in g)) for g in groups]


def review_uncertain(video, runs, y, h, duration, progress):
    """Spend the larger OCR model only on weak or conflicting visual readings."""
    targets = {i for i,r in enumerate(runs) if r['uncertain']}
    for i in range(1,len(runs)):
        a,b=runs[i-1:i+1]
        if b['s']-a['e']<STEP*2 and similarity(a['t'],b['t'])>=.8:
            targets.update((i-1,i))
    if not targets:
        return runs
    reader = CaptionReader(accurate=True)
    with closing(av.open(io.BytesIO(video))) as container:
        stream=container.streams.video[0]
        for i in sorted(targets):
            row=runs[i]; readings=[]
            for ratio in (.25,.5,.75):
                t=row['s']+(row['e']-row['s'])*ratio
                container.seek(int(t/stream.time_base),stream=stream)
                for frame in container.decode(stream):
                    if frame.time is None or frame.time<t:continue
                    image=frame.to_image(); margin=max(.018,h*.65)
                    top=max(0,int(image.height*(y-margin)));bottom=min(image.height,int(image.height*(y+margin)))
                    candidates=[(text,abs((top+cy*(bottom-top))/image.height-y),score)
                                for text,cy,_,score in reader.read(image.crop((0,top,image.width,bottom)))
                                if chinese(text) and abs((top+cy*(bottom-top))/image.height-y)<max(.018,h*.7)]
                    if candidates:readings.append(min(candidates,key=lambda x:x[1]))
                    break
                progress(duration)
            if readings:
                votes=Counter(visual_key(t) for t,_,score in readings)
                key,count=votes.most_common(1)[0]
                matches=[r for r in readings if visual_key(r[0])==key]
                text,_,score=max(matches,key=lambda r:r[2])
                if count>=2:
                    # A weak second opinion must not overwrite a better visual reading.
                    neighbor_support=any(
                        abs(j-i)==1 and max(row['s'],other['s'])-min(row['e'],other['e'])<STEP*2
                        and visual_key(other['t'])==visual_key(text)
                        for j,other in enumerate(runs))
                    if (score>=row.get('score',1) or visual_key(text)==visual_key(row['t'])
                            or (row['uncertain'] and neighbor_support and score>=.90)):
                        row['t']=text
                    row['uncertain']=score<.97
                else:row['uncertain']=True
    result=[]
    for row in runs:
        if result and row['s']-result[-1]['e']<STEP*2 and visual_key(row['t'])==visual_key(result[-1]['t']):
            result[-1]['e']=row['e'];result[-1]['uncertain'] &= row['uncertain']
        else:result.append(row)
    return result


def extract_picture(video, duration, progress=lambda t:None):
    if not math.isfinite(duration) or not 0 < duration <= 45*60:
        raise ValueError('画面字幕支持 45 分钟以内的视频。')
    reader = CaptionReader()
    with closing(av.open(io.BytesIO(video))) as container:
        if not container.streams.video:
            raise ValueError('读取到的文件没有视频画面。未改用语音听写。')
        stream = container.streams.video[0]
        actual = float(stream.duration * stream.time_base) if stream.duration is not None else float(container.duration or 0)/av.time_base
        if abs(actual-duration) > 1.5:
            raise ValueError('视频时长与当前作品不一致，已停止提取。')
        samples = []
        count = min(24, max(12, int(duration/3)))
        for i in range(count):
            t = duration*(i+.35)/count
            container.seek(int(t/stream.time_base),stream=stream)
            for frame in container.decode(stream):
                if frame.time is not None and frame.time >= t:
                    samples.append(read_frame(frame.to_image(),str,max_width=1280,correct_language=True))
                    break
            progress(0)
        y, h = choose_band(samples)
        container.seek(0,stream=stream)
        runs = []
        next_time = 0.
        report_at = 0.
        for frame in container.decode(stream):
            t = frame.time
            if t is None or t < next_time:
                continue
            next_time = t+STEP
            image = frame.to_image()
            margin = max(.018,h*.65)
            top = max(0,int(image.height*(y-margin)))
            bottom = min(image.height,int(image.height*(y+margin)))
            lines = reader.read(image.crop((0,top,image.width,bottom)))
            selected = [(text,abs((top+cy*(bottom-top))/image.height-y),score)
                        for text,cy,_,score in lines if chinese(text) and abs((top+cy*(bottom-top))/image.height-y)<max(.018,h*.7)]
            text,_,score = min(selected,key=lambda x:x[1]) if selected else ('',0,0)
            if text:
                row={'s':t,'e':min(duration,next_time),'t':text,'n':1,'score':score,'best_score':score}
                if runs and t-runs[-1]['e'] <= STEP*.1 and visual_key(text)==visual_key(runs[-1]['t']):
                    previous=runs[-1]
                    if score>previous['best_score']:previous['t']=text
                    previous['score']=(previous['score']*previous['n']+score)/(previous['n']+1)
                    previous['best_score']=max(previous['best_score'],score)
                    previous['e']=row['e'];previous['n']+=1
                else:
                    runs.append(row)
            if t>=report_at:
                progress(t);report_at=t+3
    runs = collapse_runs(runs)
    runs = review_uncertain(video,runs,y,h,duration,progress)
    if not runs:
        raise ValueError('没有读到中文字幕。未改用语音听写。')
    rows = [{k:r[k] for k in ('s','e','t')} for r in runs]
    uncertain = [i for i,r in enumerate(runs) if r['uncertain']]
    gaps = []
    edge = 0.
    for r in rows:
        if r['s']-edge > 2:
            gaps.append({'s':edge,'e':r['s']})
        edge = r['e']
    if duration-edge > 2:
        gaps.append({'s':edge,'e':duration})
    return {'captions':rows,'uncertain':uncertain,'gaps':gaps,'band':{'y':y,'height':h}}


def picture_stream(read, send, duration):
    send({'ready':True,'pictureOnly':True})
    video=bytearray()
    while True:
        message=read()
        if message.get('op')=='finish':
            break
        if message.get('op')!='picture':
            raise ValueError('原字幕模式只接收视频画面，不接收听写文字。')
        chunk=base64.b64decode(message['data'],validate=True)
        if not 0<len(chunk)<=384000 or len(video)+len(chunk)>MAX_VIDEO_BYTES:
            raise ValueError('画面数据超过 512 MiB 上限。')
        video.extend(chunk);send({'received':True})
    if not video:
        raise ValueError('没有读到完整视频画面。未改用语音听写。')
    result=extract_picture(video,duration,lambda t:send({'checkingPicture':True,'pictureTime':t}))
    # One final result, never expose a growing draft as the finished transcript.
    send({'done':True,**result})
