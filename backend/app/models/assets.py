import shlex
import uuid
import os

from sqlalchemy import ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Session, mapped_column
from app.models.frame import Frame
from app.database import Base
from arq import ArqRedis as Redis
from app.utils.remote_exec import _use_remote, run_command, upload_file
from app.models.log import new_log as log

default_assets_path = "/srv/assets"
local_fonts_path = "../frameos/assets/copied/fonts"

class Assets(Base):
    __tablename__ = 'assets'
    __table_args__ = (UniqueConstraint("project_id", "path", name="uq_assets_project_path"),)

    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    path = mapped_column(Text, nullable=False)
    data = mapped_column(LargeBinary, nullable=True)

    def to_dict(self):
        return {
            'path': self.path,
            'size': len(self.data) if self.data else 0,
        }

async def sync_assets(db: Session, redis: Redis, frame: Frame):
    assets_path = frame.assets_path or default_assets_path
    writable = await make_asset_folders(db, redis, frame, assets_path)
    if frame.upload_fonts != "none":
        if writable:
            await upload_font_assets(db, redis, frame, assets_path)
        else:
            await log(db, redis, frame.id, "stderr",
                      f"Warning: {assets_path} is not writable, skipping font sync")

ASSETS_WRITABLE_MARKER = "FRAMEOS_ASSETS_WRITABLE"

async def make_asset_folders(db: Session, redis: Redis, frame: Frame, assets_path: str) -> bool:
    # Best-effort: the assets path can sit on a vfat partition (PhotoPainter
    # images), where chown/chmod always fail and an unclean shutdown leaves the
    # mount read-only until remounted. Never fail the deploy over permissions.
    target = f"{assets_path}/fonts" if frame.upload_fonts != "none" else assets_path
    p = shlex.quote(assets_path)
    t = shlex.quote(target)
    cmd = (
        f'p={p}; t={t}; '
        f'mp=$(df -P "$p" 2>/dev/null | awk \'NR==2 {{print $6}}\'); '
        f'fstype=$(awk -v m="$mp" \'$2 == m {{f=$3}} END {{print f}}\' /proc/mounts 2>/dev/null); '
        f'opts=$(awk -v m="$mp" \'$2 == m {{o=$4}} END {{print o}}\' /proc/mounts 2>/dev/null); '
        f'case ",$opts," in *,ro,*) '
        f'  echo "$mp is mounted read-only, remounting read-write"; '
        f'  sudo mount -o remount,rw "$mp" || echo "Warning: failed to remount $mp read-write"; '
        f'esac; '
        f'[ -d "$t" ] || sudo mkdir -p "$t" || echo "Warning: failed to create $t"; '
        f'if [ ! -w "$p" ] || [ ! -w "$t" ]; then '
        f'  echo "User lacks write access to $p. Fixing..."; '
        f'  case "$fstype" in '
        f'    vfat|exfat|msdos) echo "Skipping chown/chmod on $fstype filesystem";; '
        f'    *) '
        f'      fix="$p"; if [ -w "$p" ]; then fix="$t"; fi; '
        f'      sudo chown -R "$(whoami)" "$fix" || echo "Warning: failed to chown $fix"; '
        f'      sudo chmod -R u+rwX,go+rX "$fix" || echo "Warning: failed to chmod $fix";; '
        f'  esac; '
        f'fi; '
        f'if [ -w "$p" ] && [ -w "$t" ]; then echo {ASSETS_WRITABLE_MARKER}; '
        f'else echo "Warning: $p is not writable"; fi'
    )

    _, stdout, _ = await run_command(db, redis, frame, cmd)
    return ASSETS_WRITABLE_MARKER in stdout

async def upload_font_assets(db: Session, redis: Redis, frame: Frame, assets_path: str):
    if await _use_remote(frame, redis):
        from app.ws.remote_ws import assets_list_on_frame
        assets = await assets_list_on_frame(frame.id, assets_path + "/fonts", redis=redis)
        remote_fonts = {a["path"]: int(a.get("size", 0)) for a in assets}
    else:
        command = f"find {assets_path}/fonts -type f -exec stat --format='%s %Y %n' {{}} +"
        status, stdout, _ = await run_command(db, redis, frame, command, log_output=False)
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

    custom_fonts = db.query(Assets).filter(
        Assets.project_id == frame.project_id,
        Assets.path.like("fonts/%.ttf"),
    ).all()
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

async def copy_custom_fonts_to_local_source_folder(db: Session, local_source_folder: str, project_id: int):
    custom_fonts = db.query(Assets).filter(
        Assets.project_id == project_id,
        Assets.path.like("fonts/%.ttf"),
    ).all()
    for font in custom_fonts:
        remote_path = font.path.replace("fonts/", local_source_folder + '/assets/copied/fonts/')
        if not os.path.exists(os.path.dirname(remote_path)):
            os.makedirs(os.path.dirname(remote_path))
        with open(remote_path, "wb") as fh:
            fh.write(font.data)
