import tempfile
import uuid
import os
import asyncssh
from sqlalchemy import LargeBinary, String, Text
from sqlalchemy.orm import Session, mapped_column
from app.models.frame import Frame
from app.database import Base
from arq import ArqRedis as Redis
from app.utils.ssh_utils import exec_command
from app.models.log import new_log as log

default_assets_path = "/srv/assets"
local_fonts_path = "../frameos/assets/copied/fonts"

class Assets(Base):
    __tablename__ = 'assets'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    path = mapped_column(Text, nullable=False, unique=True)
    data = mapped_column(LargeBinary, nullable=True)

    def to_dict(self):
        return {
            'path': self.path,
            'size': len(self.data) if self.data else 0,
        }

async def sync_assets(db: Session, redis: Redis, frame: Frame, ssh):
    assets_path = frame.assets_path or default_assets_path
    await make_asset_folders(db, redis, frame, ssh, assets_path)
    if frame.upload_fonts != "none":
        await upload_font_assets(db, redis, frame, ssh, assets_path)

async def make_asset_folders(db: Session, redis: Redis, frame: Frame, ssh, assets_path: str):
    if frame.upload_fonts != "none":
        await exec_command(
            db, redis, frame, ssh,
            f"if [ ! -d {assets_path}/fonts ]; then "
            f"  sudo mkdir -p {assets_path}/fonts && sudo chown -R $(whoami):$(whoami) {assets_path}; "
            f"elif [ ! -w {assets_path} ] || [ ! -w {assets_path}/fonts ]; then "
            f"  echo 'User lacks write access to {assets_path}. Fixing...'; "
            f"  sudo chown -R $(whoami):$(whoami) {assets_path}; "
            f"fi"
        )
    else:
        await exec_command(
            db, redis, frame, ssh,
            f"if [ ! -d {assets_path} ]; then "
            f"  sudo mkdir -p {assets_path} && sudo chown -R $(whoami):$(whoami) {assets_path}; "
            f"elif [ ! -w {assets_path} ]; then "
            f"  echo 'User lacks write access to {assets_path}. Fixing...'; "
            f"  sudo chown -R $(whoami):$(whoami) {assets_path}; "
            f"fi"
        )

async def upload_font_assets(db: Session, redis: Redis, frame: Frame, ssh, assets_path: str):
    command = f"find {assets_path}/fonts -type f -exec stat --format='%s %Y %n' {{}} +"
    output: list[str] = []
    await exec_command(db, redis, frame, ssh, command, output, log_output=False)

    local_fonts = {}
    for root, _, files in os.walk(local_fonts_path):
        for file in files:
            local_path = os.path.join(root, file)
            local_fonts[local_path] = os.stat(local_path).st_size

    remote_fonts = {}
    for line in output:
        if not line:
            continue
        size, mtime, path = line.split(' ', 2)
        remote_fonts[path] = int(size)

    fonts_to_upload: list[(str, str)] = []
    for local_path, local_size in local_fonts.items():
        if not local_path.endswith('.ttf') and not local_path.endswith('.txt') and not local_path.endswith('.md'):
            continue
        remote_path = local_path.replace(local_fonts_path, assets_path + '/fonts')
        remote_size = remote_fonts.get(remote_path)
        if remote_size is None or remote_size != local_size:
            fonts_to_upload.append((local_path, remote_path))

    custom_fonts = db.query(Assets).filter(Assets.path.like("fonts/%.ttf")).all()
    custom_fonts_to_upload = []
    for font in custom_fonts:
        remote_path = font.path.replace("fonts/", assets_path + '/fonts/')
        remote_size = remote_fonts.get(remote_path)
        if remote_size is None or remote_size != len(font.data):
            custom_fonts_to_upload.append((font, remote_path))

    if not fonts_to_upload and not custom_fonts_to_upload:
        await log(db, redis, frame.id, "stdout", "No fonts to upload")
    else:
        await log(db, redis, frame.id, "stdout", f"Uploading {len(fonts_to_upload) + len(custom_fonts_to_upload)} fonts")
        for local_path, remote_path in fonts_to_upload:
            await asyncssh.scp(
                local_path, (ssh, remote_path),
                recurse=False
            )
        for font, remote_path in custom_fonts_to_upload:
            with tempfile.NamedTemporaryFile(suffix=".ttf", delete=False) as tmpf:
                tempfile_path = tmpf.name
                tmpf.write(font.data)
            await asyncssh.scp(
                tempfile_path, (ssh, remote_path),
                recurse=False
            )
            os.remove(tempfile_path)  # remove local temp file
        await log(db, redis, frame.id, "stdout", f"Uploaded {len(fonts_to_upload) + len(custom_fonts_to_upload)} fonts")
