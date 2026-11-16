"""Register the local VideoCaptioner bridge for this unpacked Chrome extension on macOS."""
import hashlib
import json
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
if sys.platform != 'darwin':
    raise SystemExit('此安装脚本适用于 macOS 的 Google Chrome。')
install = Path.home() / 'Library/Application Support/Shiju/VideoCaptioner'
if not (install / 'runtime/bin/videocaptioner').is_file():
    raise SystemExit('请先按 README 安装本机卡卡字幕助手。')
for name in ('kaka-launch', 'kaka_host.py', 'precision.py', 'screen_captions.py'):
    shutil.copy2(root / 'native' / name, install / name)
digest = hashlib.sha256(str(root / 'extension').encode()).hexdigest()[:32]
extension_id = digest.translate(str.maketrans('0123456789abcdef', 'abcdefghijklmnop'))
folder = Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
folder.mkdir(parents=True, exist_ok=True)
host = {'name': 'cn.shiju.videocaptioner', 'description': '拾句 · 卡卡字幕助手',
        'path': str(install / 'kaka-launch'), 'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{extension_id}/']}
manifest = folder / 'cn.shiju.videocaptioner.json'
manifest.write_text(json.dumps(host, indent=2), encoding='utf-8')
print(f'已连接拾句 {extension_id}')
