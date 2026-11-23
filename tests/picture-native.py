"""Run the real Chrome native protocol against a supplied local video (no browser mocks).
Usage: python tests/picture-native.py VIDEO OUTPUT_JSON [--host INSTALLED_HOST]
"""
import argparse
import base64
import json
import pathlib
import struct
import subprocess
import sys
import time
import av

parser=argparse.ArgumentParser()
parser.add_argument('video',type=pathlib.Path)
parser.add_argument('output',type=pathlib.Path)
parser.add_argument('--host',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[1]/'native/kaka_host.py')
args=parser.parse_args()
with av.open(str(args.video)) as c:
    stream=c.streams.video[0]
    duration=float(stream.duration*stream.time_base)
process=subprocess.Popen([sys.executable,'-I',str(args.host)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def send(value):
    data=json.dumps(value).encode()
    process.stdin.write(struct.pack('=I',len(data))+data);process.stdin.flush()
def read():
    header=process.stdout.read(4)
    assert len(header)==4,'native host closed before completion'
    size,=struct.unpack('=I',header)
    assert 0<size<1024*1024
    result=json.loads(process.stdout.read(size))
    assert 'error' not in result,result
    assert 'rows' not in result,'partial text leaked before completion'
    return result
start=time.monotonic()
try:
    send({'op':'pictureOnly','duration':duration})
    assert read()=={'ready':True,'pictureOnly':True}
    with args.video.open('rb') as video:
        while chunk:=video.read(384000):
            send({'op':'picture','data':base64.b64encode(chunk).decode()})
            assert read()=={'received':True}
    send({'op':'finish'})
    next_report=0
    while True:
        message=read()
        if message.get('done'):break
        assert message.get('checkingPicture'),message
        if message['pictureTime']>=next_report:
            print('Checked video seconds:',round(message['pictureTime'],1),flush=True)
            next_report=message['pictureTime']+30
    assert message.get('captions')
    args.output.write_text(json.dumps(message,ensure_ascii=False,indent=2))
    process.stdin.close()
    assert process.wait(timeout=10)==0
    print('PASS actual native host:',len(message['captions']),'lines;',round(time.monotonic()-start,1),'seconds')
finally:
    if process.poll() is None:process.kill();process.wait()
