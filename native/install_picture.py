"""One-time installation of pinned local subtitle OCR models; no user media is sent."""
from importlib.metadata import version
from pathlib import Path
import tempfile
import yaml
import rapidocr
from rapidocr import download_models

if version('rapidocr') != '3.10.0':
    raise SystemExit('请先安装 rapidocr==3.10.0。')
root=Path(rapidocr.__file__).resolve().parent
config=yaml.safe_load((root/'config.yaml').read_text())
config['Global']['model_root_dir']=str(root/'models')
config['Global']['use_cls']=False
config['Rec']['model_type']='medium'
with tempfile.NamedTemporaryFile(mode='w+',suffix='.yaml') as temp:
    yaml.safe_dump(config,temp);temp.flush()
    download_models(temp.name)
print('画面识别模型已就绪；日常提取不再下载模型。')
