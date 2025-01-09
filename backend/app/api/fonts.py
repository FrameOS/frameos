from app.models.fonts import gather_all_fonts_info
from app.schemas.fonts import FontsListResponse

from . import api_with_auth

@api_with_auth.get("/fonts", response_model=FontsListResponse)
async def api_fonts_list():
    all_fonts = gather_all_fonts_info('../frameos/assets/fonts')
    return {"fonts": all_fonts}
