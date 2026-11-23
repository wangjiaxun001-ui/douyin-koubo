"""Chrome native host for local audio, picture subtitles and cue editing."""
import json
import math
import struct
import sys


def split_rows(rows):
    from videocaptioner.core.prompts import get_prompt

    if not isinstance(rows, list) or not rows or len(rows) > 15000:
        raise ValueError('逐字稿为空或过长。')
    result = []
    for row in rows:
        start, end, text = row['s'], row['e'], row['t'].strip()
        if not all(math.isfinite(v) for v in (start, end)) or not 0 <= start <= end:
            raise ValueError('字幕时间无效。')
        if text:
            result.append({'s': round(start * 1000), 'e': round(end * 1000), 't': text})
    return {'rows': result, 'prompt': get_prompt('optimize/subtitle')}


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        raise EOFError()
    size, = struct.unpack('=I', header)
    if size > 900_000:
        raise ValueError('数据过长。')
    return json.loads(sys.stdin.buffer.read(size))


def main():
    # Chrome launches Python with -I, so sibling modules are not on sys.path.
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    output = sys.stdout.buffer
    sys.stdout = sys.stderr

    def send(reply):
        payload = json.dumps(reply, ensure_ascii=False).encode()
        if len(payload) >= 1024 * 1024:
            raise ValueError('结果过长。')
        output.write(struct.pack('=I', len(payload)) + payload)
        output.flush()

    try:
        message = read_message()
        if message.get('op') == 'pictureOnly':
            from picture_only import picture_stream
            picture_stream(read_message,send,float(message['duration']))
            read_message()
        elif message.get('op') == 'transcribe':
            from precision import transcribe_stream
            transcribe_stream(read_message, send, str(message.get('terms') or ''))
            # Keep the port alive until Chrome has persisted the final result.
            read_message()
        elif message.get('op') == 'split':
            send(split_rows(message['rows']))
        else:
            raise ValueError('未知操作。')
    except (EOFError, BrokenPipeError):
        return
    except (ValueError, KeyError, TypeError) as error:
        send({'error': str(error)})
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        send({'error': '本机识别组件未就绪，请检查安装。'})


if __name__ == '__main__':
    main()
