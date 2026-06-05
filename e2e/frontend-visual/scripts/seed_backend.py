from __future__ import annotations

import asyncio
import io
import json
import math
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("DEBUG", "1")
os.environ.setdefault("SECRET_KEY", "frontend-visual-secret")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT / '.tmp' / 'frontend-visual.db'}")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/15")

database_url = os.environ["DATABASE_URL"]
if database_url.startswith("sqlite:///") and database_url != "sqlite:///:memory:":
    Path(database_url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)

from PIL import Image, ImageDraw, ImageFont

import app.models  # noqa: F401
from app.database import Base, SessionLocal, engine
from app.models.frame import Frame
from app.models.log import Log
from app.models.metrics import Metrics
from app.models.scene_image import SceneImage
from app.models.settings import Settings
from app.models.user import User
from app.redis import close_redis_connection, create_redis_connection
from app.tenancy import ensure_default_project_for_user

VISUAL_EMAIL = "visual@example.com"
VISUAL_PASSWORD = "visual-password"
FIXED_NOW = datetime(2026, 5, 23, 12, 0, 0)


def load_scene(name: str, *, scene_id: str, label: str | None = None, fields: list[dict[str, Any]] | None = None) -> dict:
    with open(ROOT / "e2e" / "scenes" / f"{name}.json", "r") as file:
        scene = json.load(file)
    scene["id"] = scene_id
    if label:
        scene["name"] = label
    if fields is not None:
        scene["fields"] = fields
    scene.setdefault("settings", {})
    scene["settings"] = {
        "execution": "interpreted",
        "refreshInterval": 300,
        "backgroundColor": scene["settings"].get("backgroundColor", "#111827"),
        **scene["settings"],
    }
    return scene


def make_visual_png(width: int, height: int, title: str, background: str, accent: str) -> bytes:
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype(str(ROOT / "frameos/assets/compiled/fonts/Ubuntu-Regular.ttf"), 38)
        small = ImageFont.truetype(str(ROOT / "frameos/assets/compiled/fonts/Ubuntu-Regular.ttf"), 20)
    except Exception:
        font = ImageFont.load_default()
        small = ImageFont.load_default()

    for i in range(0, width, 64):
        color = accent if (i // 64) % 2 == 0 else "#ffffff"
        draw.rectangle((i, 0, i + 34, height), fill=color)
    draw.rounded_rectangle((48, 48, width - 48, height - 48), radius=24, fill=background, outline=accent, width=4)
    draw.text((80, 78), title, fill="#ffffff", font=font)
    draw.text((80, 132), "FrameOS visual fixture", fill="#dbeafe", font=small)
    draw.text((80, height - 92), f"{width} x {height}", fill="#dbeafe", font=small)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def make_thumb(image_bytes: bytes) -> tuple[bytes, int, int]:
    with Image.open(io.BytesIO(image_bytes)) as image:
        if image.mode != "RGB":
            image = image.convert("RGB")
        scale = min(320 / image.width, 320 / image.height, 1.0)
        width = int(round(image.width * scale))
        height = int(round(image.height * scale))
        image = image.resize((width, height), Image.Resampling.BICUBIC)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG")
        return buffer.getvalue(), width, height


def base_frame_kwargs() -> dict[str, Any]:
    return {
        "mode": "rpios",
        "frame_port": 8787,
        "frame_access_key": "visual-frame-key",
        "frame_access": "private",
        "frame_admin_auth": {"enabled": False, "user": "", "pass": ""},
        "https_proxy": {
            "enable": True,
            "port": 8443,
            "expose_only_port": True,
            "certs": {"server": "", "server_key": "", "client_ca": ""},
        },
        "ssh_user": "pi",
        "ssh_pass": "",
        "ssh_port": 22,
        "ssh_keys": [],
        "server_host": "localhost",
        "server_port": 8989,
        "server_api_key": "visual-server-key",
        "server_send_logs": True,
        "version": "0.9.0-visual",
        "device": "web_only",
        "device_config": {},
        "color": "full",
        "interval": 300,
        "metrics_interval": 60,
        "scaling_mode": "contain",
        "rotate": 0,
        "flip": None,
        "background_color": "#111827",
        "debug": True,
        "log_to_file": "/srv/frameos/logs/frame-{date}.log",
        "assets_path": "/srv/assets",
        "save_assets": True,
        "upload_fonts": "",
        "reboot": {"enabled": "true", "crontab": "0 4 * * *", "type": "frameos"},
        "control_code": {"enabled": "true", "position": "top-right", "size": "2", "padding": "1"},
        "gpio_buttons": [{"pin": 5, "label": "Next"}, {"pin": 6, "label": "Previous"}],
        "network": {
            "networkCheck": True,
            "networkCheckTimeoutSeconds": 30,
            "networkCheckUrl": "https://networkcheck.frameos.net/",
            "wifiHotspot": "bootOnly",
            "wifiHotspotSsid": "FrameOS-Setup",
            "wifiHotspotPassword": "frame1234",
            "wifiHotspotTimeoutSeconds": 300,
        },
        "agent": {"agentEnabled": True, "agentRunCommands": False, "agentSharedSecret": "visual-agent-secret"},
        "palette": {},
        "buildroot": {"enabled": False},
        "rpios": {"enabled": True},
        "terminal_history": ["uptime", "journalctl -u frameos -n 50", "df -h"],
    }


def create_data() -> tuple[Frame, list[dict[str, Any]]]:
    public_fields = [
        {"name": "headline", "label": "Headline", "type": "string", "access": "public", "value": "Morning"},
        {"name": "accent", "label": "Accent", "type": "string", "access": "public", "value": "#6f42c1"},
    ]
    scenes = [
        load_scene("renderTextRich", scene_id="scene-dashboard", label="Dashboard", fields=public_fields),
        load_scene("dataGradient", scene_id="scene-gradient", label="Gradient status"),
        load_scene("renderImage", scene_id="scene-gallery", label="Gallery"),
        load_scene("dataQR", scene_id="scene-qr", label="QR info"),
        load_scene("sceneNodes", scene_id="scene-nodes", label="Node map"),
    ]

    last_successful_deploy = {
        "scenes": scenes[:4],
        "frameos_version": "0.9.0-visual",
        "deployed_at": (FIXED_NOW - timedelta(minutes=9)).isoformat(),
    }

    primary_frame = Frame(
        id=1,
        name="Kitchen dashboard",
        frame_host="127.0.0.1",
        status="ready",
        archived=False,
        width=800,
        height=480,
        scenes=scenes,
        schedule={
            "events": [
                {
                    "id": "schedule-morning",
                    "hour": 7,
                    "minute": 15,
                    "weekday": 8,
                    "event": "setCurrentScene",
                    "payload": {"sceneId": "scene-dashboard", "state": {"headline": "Morning"}},
                },
                {
                    "id": "schedule-evening",
                    "hour": 18,
                    "minute": 45,
                    "weekday": 0,
                    "event": "setCurrentScene",
                    "payload": {"sceneId": "scene-gradient", "state": {}},
                },
            ]
        },
        last_log_at=FIXED_NOW - timedelta(minutes=1),
        last_successful_deploy=last_successful_deploy,
        last_successful_deploy_at=FIXED_NOW - timedelta(minutes=9),
        **base_frame_kwargs(),
    )
    inactive_frame = Frame(
        id=2,
        name="Office portrait",
        frame_host="192.0.2.20",
        status="offline",
        archived=False,
        width=600,
        height=800,
        scenes=[scenes[0]],
        schedule={"events": []},
        last_log_at=FIXED_NOW - timedelta(hours=4),
        last_successful_deploy=last_successful_deploy,
        last_successful_deploy_at=FIXED_NOW - timedelta(days=1),
        **base_frame_kwargs(),
    )
    archived_frame = Frame(
        id=3,
        name="Archived lab frame",
        frame_host="192.0.2.30",
        status="stopped",
        archived=True,
        width=1024,
        height=768,
        scenes=[scenes[1]],
        schedule={"events": []},
        last_log_at=FIXED_NOW - timedelta(days=5),
        **base_frame_kwargs(),
    )

    db = SessionLocal()
    try:
        user = User(email=VISUAL_EMAIL)
        user.set_password(VISUAL_PASSWORD)
        db.add(user)
        db.commit()
        db.refresh(user)
        project = ensure_default_project_for_user(db, user)

        for frame in (primary_frame, inactive_frame, archived_frame):
            frame.project_id = project.id
            frame.server_api_key = f"visual-server-key-{frame.id}"
        db.add_all([primary_frame, inactive_frame, archived_frame])

        db.add_all(
            [
                Settings(project_id=project.id, key="openAI", value={"backendApiKey": "sk-visual-fixture", "imageGenerationModel": "gpt-image-1"}),
                Settings(project_id=project.id, key="stabilityAI", value={"apiKey": "visual-stability-key"}),
            ]
        )

        log_messages = [
            ("stdout", "Frame boot completed"),
            ("stdout", "Loaded 5 scenes from /srv/frameos/scenes"),
            ("webhook", json.dumps({"event": "render:sceneChange", "sceneId": "scene-dashboard"})),
            ("stdout", "Rendered scene scene-dashboard in 182ms"),
            ("stderr", "Asset cache check skipped: no changes"),
        ]
        for index in range(45):
            log_type, line = log_messages[index % len(log_messages)]
            db.add(
                Log(
                    project_id=project.id,
                    frame_id=1,
                    type=log_type,
                    line=line,
                    timestamp=FIXED_NOW - timedelta(minutes=44 - index),
                    ip="127.0.0.1",
                )
            )

        for index in range(120):
            timestamp = FIXED_NOW - timedelta(minutes=119 - index)
            load = 0.12 + 0.06 * math.sin(index / 8)
            used_memory = 190_000_000 + (index % 24) * 2_000_000
            disk_used = 4_100_000_000 + index * 650_000
            db.add(
                Metrics(
                    project_id=project.id,
                    frame_id=1,
                    timestamp=timestamp,
                    metrics={
                        "intervalMs": 60_000,
                        "load": [round(load, 3), round(load * 0.8, 3), round(load * 0.6, 3)],
                        "memoryUsage": {"total": 512_000_000, "used": used_memory, "available": 512_000_000 - used_memory},
                        "diskUsage": {"total": 58_000_000_000, "used": disk_used, "available": 58_000_000_000 - disk_used},
                        "processMemory": {"rss": 92_000_000 + index * 15_000, "heapUsed": 41_000_000 + index * 8_000},
                        "runtime": {"width": 800, "height": 480, "renderMs": 160 + (index % 12)},
                        "temperature": 46 + 2 * math.sin(index / 10),
                    },
                )
            )

        preview_colors = [
            ("#172554", "#8b5cf6"),
            ("#064e3b", "#14b8a6"),
            ("#7f1d1d", "#f97316"),
            ("#312e81", "#facc15"),
            ("#1f2937", "#38bdf8"),
        ]
        for scene, (background, accent) in zip(scenes, preview_colors):
            png = make_visual_png(800, 480, scene["name"], background, accent)
            thumb, thumb_width, thumb_height = make_thumb(png)
            db.add(
                SceneImage(
                    project_id=project.id,
                    frame_id=1,
                    scene_id=scene["id"],
                    image=png,
                    width=800,
                    height=480,
                    thumb_image=thumb,
                    thumb_width=thumb_width,
                    thumb_height=thumb_height,
                    timestamp=FIXED_NOW - timedelta(minutes=5),
                )
            )

        db.commit()
    finally:
        db.close()

    return primary_frame, scenes


async def seed_redis(frame: Frame, scenes: list[dict[str, Any]]) -> None:
    redis = create_redis_connection()
    try:
        await redis.flushdb()
        await redis.set(f"frame:{frame.id}:active_scene", scenes[0]["id"])
        await redis.set(f"frame:{frame.id}:active_connections", "1")
        await redis.set(f"frame:{frame.frame_host}:{frame.frame_port}:image", make_visual_png(800, 480, "Live preview", "#111827", "#8b5cf6"))
        await redis.set(
            f"frame:{frame.frame_host}:{frame.frame_port}:state",
            json.dumps({"sceneId": scenes[0]["id"], "state": {"headline": "Morning", "accent": "#6f42c1"}}),
        )
        await redis.set(
            f"frame:{frame.frame_host}:{frame.frame_port}:uploaded_scenes",
            json.dumps({"sceneId": scenes[0]["id"], "scenes": [{"id": scene["id"], "name": scene["name"]} for scene in scenes]}),
        )
    finally:
        await close_redis_connection(redis)


async def main() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    frame, scenes = create_data()
    await seed_redis(frame, scenes)
    print("Seeded frontend visual backend data")


if __name__ == "__main__":
    asyncio.run(main())
