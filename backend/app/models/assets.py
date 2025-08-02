import uuid
import os

from sqlalchemy import LargeBinary, String, Text
from sqlalchemy.orm import Session, mapped_column
from app.models.frame import Frame
from app.database import Base
from arq import ArqRedis as Redis
from app.utils.remote_exec import _use_agent, run_commands, run_command, upload_file
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

async def sync_assets(db: Session, redis: Redis, frame: Frame):
    assets_path = frame.assets_path or default_assets_path
    await make_asset_folders(db, redis, frame, assets_path)
    if frame.upload_fonts != "none":
        await upload_font_assets(db, redis, frame, assets_path)

async def make_asset_folders(db: Session, redis: Redis, frame: Frame, assets_path: str):
    if frame.upload_fonts != "none":
        cmd = (
            f"if [ ! -d {assets_path}/fonts ]; then "
            f"  sudo mkdir -p {assets_path}/fonts && sudo chown -R $(whoami) {assets_path} && sudo chmod -R u+rwX,go+rX {assets_path}; "
            f"elif [ ! -w {assets_path} ]; then "
            f"  echo 'User lacks write access to {assets_path}. Fixing...'; "
            f"  sudo chown -R $(whoami) {assets_path} && sudo chmod -R u+rwX,go+rX {assets_path}; "
            f"elif [ ! -w {assets_path}/fonts ]; then "
            f"  echo 'User lacks write access to {assets_path}/fonts. Fixing...'; "
            f"  sudo chown -R $(whoami) {assets_path}/fonts && sudo chmod -R u+rwX,go+rX {assets_path}/fonts; "
            f"fi"
        )
    else:
        cmd = (
            f"if [ ! -d {assets_path} ]; then "
            f"  sudo mkdir -p {assets_path} && sudo chown -R $(whoami) {assets_path} && sudo chmod -R u+rwX,go+rX {assets_path}; "
            f"elif [ ! -w {assets_path} ]; then "
            f"  echo 'User lacks write access to {assets_path}. Fixing...'; "
            f"  sudo chown -R $(whoami) {assets_path} && sudo chmod -R u+rwX,go+rX {assets_path}; "
            f"fi"
        )

    await run_commands(db, redis, frame, [cmd])

async def upload_font_assets(db: Session, redis: Redis, frame: Frame, assets_path: str):
    if await _use_agent(frame, redis):
        from app.ws.agent_ws import assets_list_on_frame
        assets = await assets_list_on_frame(frame.id, assets_path + "/fonts")
        remote_fonts = {a["path"]: int(a.get("size", 0)) for a in assets}
    else:
        command = f"find {assets_path}/fonts -type f -exec stat --format='%s %Y %n' {{}} +"
        status, stdout, _ = await run_command(db, redis, frame, command)
        stdout_lines = stdout.splitlines()
        remote_fonts = {}
        for line in stdout_lines:
            if not line:
                continue
            size, mtime, path = line.split(' ', 2)
            remote_fonts[path] = int(size)

    local_fonts = {}
    for root, _, files in os.walk(local_fonts_path):
        for file in files:
            local_path = os.path.join(root, file)
            local_fonts[local_path] = os.stat(local_path).st_size

    fonts_to_upload: list[tuple[str, str]] = []
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
        return

    await log(
        db,
        redis,
        frame.id,
        "stdout",
        f"Uploading {len(fonts_to_upload) + len(custom_fonts_to_upload)} fonts",
    )

    for local_path, remote_path in fonts_to_upload:
        with open(local_path, "rb") as fh:
            data = fh.read()
        await upload_file(db, redis, frame, remote_path, data)
    for font, remote_path in custom_fonts_to_upload:
        await upload_file(db, redis, frame, remote_path, font.data)

async def copy_custom_fonts_to_local_source_folder(db: Session, local_source_folder: str):
    custom_fonts = db.query(Assets).filter(Assets.path.like("fonts/%.ttf")).all()
    for font in custom_fonts:
        remote_path = font.path.replace("fonts/", local_source_folder + '/assets/copied/fonts/')
        if not os.path.exists(os.path.dirname(remote_path)):
            os.makedirs(os.path.dirname(remote_path))
        with open(remote_path, "wb") as fh:
            fh.write(font.data)
