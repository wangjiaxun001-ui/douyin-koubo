"""Read subtitles painted into video frames using on-device macOS Vision."""
import bisect
import difflib
import io
import re
import statistics
from collections import Counter
from contextlib import closing

import av
import Foundation
import Vision
import objc


def normalize(text):
    return ''.join(re.findall(r'[a-z0-9\u4e00-\u9fff]', text.lower()))


def agreement(text, nearby):
    a, b = normalize(text), normalize(nearby)
    if len(a) < 2 or not b:
        return 0
    if a in b:
        return 1
    match = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return sum(m.size for m in match.get_matching_blocks() if m.size >= 2) / len(a)


def read_frame(image, convert, terms=()):
    if image.width > 960:
        image = image.resize((960, round(image.height * 960 / image.width)))
    encoded = io.BytesIO()
    image.save(encoded, format='JPEG', quality=90)
    data = encoded.getvalue()
    with objc.autorelease_pool():
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(['zh-Hans','en-US'])
        request.setUsesLanguageCorrection_(True)
        if terms:
            request.setCustomWords_(list(terms))
        nsdata = Foundation.NSData.dataWithBytes_length_(data, len(data))
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(nsdata, {})
        ok, _ = handler.performRequests_error_([request], None)
        if not ok:
            return []
        lines = []
        for observation in request.results():
            candidates = observation.topCandidates_(1)
            if not candidates:
                continue
            text = convert(str(candidates[0].string()).strip())
            box = observation.boundingBox()
            center = 1 - box.origin.y - box.size.height / 2
            if len(normalize(text)) >= 2:
                lines.append((text, center, box.size.height, box.origin.x, box.size.width))
        # Vision sometimes returns two horizontal pieces of one subtitle line.
        # Join pieces on the same baseline before comparing successive frames.
        groups = []
        for item in sorted(lines, key=lambda x:x[3]):
            for group in groups:
                previous = group[-1]
                gap = item[3] - previous[3] - previous[4]
                if abs(item[1]-previous[1]) <= min(item[2],previous[2])*.48 and -.02 <= gap <= .16:
                    group.append(item)
                    break
            else:
                groups.append([item])
        def join_line(group):
            line = group[0][0]
            for item in group[1:]:
                if line[-1].isascii() and line[-1].isalnum() and item[0][0].isascii() and item[0][0].isalnum():
                    line += ' '
                line += item[0]
            return line,statistics.median(v[1] for v in group),max(v[2] for v in group)
        return [join_line(g) for g in groups]


def same_display(a, b):
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return False
    short, long = sorted((a,b),key=len)
    if short == long or (len(short)>=2 and (long.startswith(short) or long.endswith(short))):
        return True
    return difflib.SequenceMatcher(None,a,b,autojunk=False).ratio() >= .74


def representative(run, nearby):
    votes = run['votes']
    # Prefer a full line over a prefix/suffix flashed during an animation.
    # Among similar complete readings, use evidence from the audio and votes.
    longest = max(len(normalize(t)) for t in votes)
    candidates = [t for t in votes if len(normalize(t)) >= longest*.75]
    heard = nearby((run['s']+run['e'])/2)
    def rank(text):
        n = normalize(text)
        consensus = sum(count * difflib.SequenceMatcher(None,n,normalize(other)).ratio()
                        for other,count in votes.items()) / votes.total()
        return consensus + .55*agreement(text,heard) + .12*votes[text]/votes.total()
    return max(candidates,key=rank)


def clean_display(captions, nearby):
    result = []
    for row in captions:
        text = row['t']
        # A camera overlay can share a baseline with the dialogue. Keep it
        # when the speaker actually mentions the resolution or frame rate.
        overlay = re.match(r'^\s*(?:[248]K|1080P)\s*[0-9GO]{2,3}\s*FPS\s*', text, re.I)
        heard = nearby((row['s']+row['e'])/2)
        if overlay and not re.search(r'[248]k|帧|fps',heard,re.I):
            text = text[overlay.end():].strip()
        if not text:
            continue
        if result and row['s']-result[-1]['e'] <= .36 and normalize(text)==normalize(result[-1]['t']):
            if normalize(heard).count(normalize(text)) < 2:
                result[-1]['e'] = row['e']
                continue
        result.append({**row,'t':text})
    return result


def original_rows(video, speech, duration, convert, progress, terms=()):
    starts = [row['s'] for row in speech]
    def nearby(t):
        pos = bisect.bisect_left(starts, t - 1.5)
        return ''.join(r['t'] for r in speech[max(0,pos-1):bisect.bisect_right(starts,t+1.5)] if r['e'] >= t-1.5)

    with closing(av.open(io.BytesIO(video))) as container:
        stream = container.streams.video[0]
        if stream.duration is None or abs(float(stream.duration * stream.time_base) - duration) > 1.5:
            return None
        sample_times = [duration * (i+.4)/12 for i in range(12)]
        hits = []
        for t in sample_times:
            container.seek(int(t/stream.time_base),stream=stream)
            for frame in container.decode(stream):
                if frame.time is None or frame.time < t:
                    continue
                for text, y, h in read_frame(frame.to_image(),convert,terms):
                    score = agreement(text,nearby(t))
                    if len(normalize(text)) >= 3 and score >= .50:
                        hits.append((y,h,score))
                break
        if len(hits) < 3:
            return None
        # Only read a stable subtitle band supported by words heard at the same time.
        best = max(hits,key=lambda p:sum(x[2] for x in hits if abs(x[0]-p[0])<.035))
        cluster = [p for p in hits if abs(p[0]-best[0])<.035]
        if len(cluster)<3:
            return None
        y = statistics.median(p[0] for p in cluster)
        height = max(.035,statistics.median(p[1] for p in cluster)*1.55)
        container.seek(0,stream=stream)
        runs = []
        last = None
        next_time = 0.
        report_at = 0.
        for frame in container.decode(stream):
            t = frame.time
            if t is None or t < next_time:
                continue
            next_time = t + .27
            img = frame.to_image()
            top = max(0,int(img.height*(y-height)))
            bottom = min(img.height,int(img.height*(y+height)))
            crop = img.crop((0,top,img.width,bottom))
            lines = read_frame(crop,convert,terms)
            choices = []
            for text, cy, _ in lines:
                if abs((top + cy*(bottom-top))/img.height-y) < height*.75:
                    choices.append((text,agreement(text,nearby(t))))
            choice = max(choices,key=lambda c:c[1] + .12*min(1,len(normalize(c[0]))/12), default=('',0))
            text, score = choice
            if not text:
                last = None
            elif last and any(same_display(text,prior) for prior in last['votes']):
                last['votes'][text]+=1
                last['prev']=text
                last['match']=max(last['match'],score)
                last['e']=min(duration,next_time)
            else:
                last={'s':t,'e':min(duration,next_time),'votes':Counter([text]),'prev':text,'match':score}
                runs.append(last)
            if t >= report_at:
                progress(t)
                report_at = t+6
    captions = []
    for run in runs:
        text = representative(run,nearby)
        supported_band = re.search('[\u4e00-\u9fff]',text) and run['votes'].total() >= 2 and run['e']-run['s'] <= 9
        if run['match'] >= .35 or supported_band:
            captions.append({'s':run['s'],'e':run['e'],'t':text})
    # If the selected band misses large portions of the speech, keep the audio
    # result. Do not present a few overlays as a complete caption track.
    captions = clean_display(captions, nearby)
    if len(captions)<3:
        return None
    edges = [c['e'] for c in captions]
    covered = 0
    total = 0
    for r in speech:
        span = r['e']-r['s']
        total += span
        i = bisect.bisect_left(edges,r['s'])
        overlap = 0.
        while i < len(captions) and captions[i]['s'] < r['e']:
            overlap += max(0.,min(r['e'],captions[i]['e'])-max(r['s'],captions[i]['s']))
            i += 1
        if span > 1 and overlap < span*.40:
            return None
        covered += min(span,overlap)
    return captions if total and covered/total >= .78 else None
