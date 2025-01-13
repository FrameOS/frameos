import io
import os
from fastapi import Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.assets import Assets
from app.models.fonts import gather_all_fonts_info, parse_font_info_in_memory
from app.schemas.fonts import FontMetadata, FontsListResponse
from . import api_with_auth

@api_with_auth.get("/fonts", response_model=FontsListResponse)
async def api_fonts_list(db: Session = Depends(get_db)):
    """
    Return a combined list of font metadata from:
      1) local ../frameos/assets/copied/fonts
      2) DB assets with path starting with fonts/
    """
    # 1) Gather local fonts from folder
    local_list = gather_all_fonts_info("../frameos/assets/copied/fonts")

    # 2) Gather DB fonts with path like "fonts/..."
    db_assets = db.query(Assets).filter(Assets.path.like("fonts/%")).all()  # [NEW]
    for asset in db_assets:
        # asset.path is e.g. "fonts/MyFont.ttf"
        filename = os.path.basename(asset.path)
        if not filename.lower().endswith(".ttf"):
            continue
        # parse in-memory
        try:
            font_info = parse_font_info_in_memory(asset.data, filename)
            local_list.append(font_info.dict())
        except Exception:
            # If we can't parse, skip or log
            pass

    # Build a combined list of FontMetadata objects
    combined_fonts = []
    for item in local_list:
        # gather_all_fonts_info returns raw dicts, so unify them into FontMetadata
        if isinstance(item, dict):
            combined_fonts.append(FontMetadata(**item))
        else:
            # or if gather_all_fonts_info returned FontMetadata directly
            combined_fonts.append(item)

    return {"fonts": combined_fonts}


@api_with_auth.get("/fonts/{font_name}")
async def api_fonts_download(font_name: str, db: Session = Depends(get_db)):
    """
    Download a font by name. Checks DB first, then local folder.
    If found in DB, returns a StreamingResponse from memory.
    If found locally, returns a FileResponse from disk.
    """
    # 1) Check DB for path="fonts/<font_name>"
    asset = db.query(Assets).filter_by(path=f"fonts/{font_name}").first()
    if asset:
        if not asset.data:
            raise HTTPException(status_code=404, detail="Font asset has no data")
        # return an in-memory streaming response
        return StreamingResponse(
            io.BytesIO(asset.data),
            media_type="font/ttf",
            headers={"Content-Disposition": f'attachment; filename="{font_name}"'},
        )

    # 2) Check local folder
    local_path = f"../frameos/assets/copied/fonts/{font_name}"
    if "/" in font_name or "\\" in font_name:
        return {"error": "Invalid font filename"}
    if os.path.isfile(local_path):
        # Same logic as before. If you want a file download:
        return FileResponse(
            local_path,
            filename=font_name,
            media_type="font/ttf",
            headers={"Cache-Control": "max-age=86400"},
        )

    return {"error": "font not found"}
