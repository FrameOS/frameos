import time

from fastapi.responses import FileResponse
from app.models.fonts import gather_all_fonts_info
from app.schemas.fonts import FontsListResponse

from . import api_with_auth

last_updated = 0
all_fonts: list[dict] = []

def _update_all_fonts():
    global last_updated, all_fonts
    last_updated = time.time()
    all_fonts = gather_all_fonts_info('../frameos/assets/copied/fonts')

@api_with_auth.get("/fonts", response_model=FontsListResponse)
async def api_fonts_list():
    _update_all_fonts()
    return {"fonts": all_fonts}

@api_with_auth.get("/fonts/{font_name}", response_class=FileResponse)
async def api_fonts_download(font_name: str):
    _update_all_fonts()
    if "/" in font_name or font_name not in [font["file"] for font in all_fonts]:
        return {"error": "font not found"}
    return FileResponse(f"../frameos/assets/copied/fonts/{font_name}", filename=font_name, headers={"Cache-Control": "max-age=86400"})
