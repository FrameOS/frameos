import os
import io
from fontTools.ttLib import TTFont
from app.schemas.fonts import FontMetadata

# Simple mapping from weight class to a rough textual label
WEIGHT_MAP = {
    100: "Thin",
    200: "ExtraLight",
    300: "Light",
    350: "Book",        # Not an official standard, but used by some fonts
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black",
}

def get_weight_title_from_usWeightClass(weight_class):
    """
    Returns a human-readable weight name from a numeric usWeightClass.
    If we can't find an exact match, returns the numeric value as a string.
    """
    return WEIGHT_MAP.get(weight_class, str(weight_class))

def get_font_info(ttf_path):
    """
    Extracts:
       - family_name:  Prefer 'typographic family name' (nameID=16), else nameID=1
       - weight_title: Derived from subfamily name or OS/2 weight
       - numeric_weight (usWeightClass)
       - italic (bool)
    """
    font = TTFont(ttf_path)
    name_table = font["name"]

    # ----- Family name (try nameID=16 first, else fallback to nameID=1) -----
    family_name = None

    # 1) Attempt to find nameID=16 (typographic family name)
    for record in name_table.names:
        if record.nameID == 16 and (record.platformID, record.platEncID, record.langID) in [
            (3, 1, 0x409),
            (1, 0, 0),
        ]:
            family_name = record.toUnicode()
            break

    # 2) If not found, fallback to nameID=1 (family name)
    if not family_name:
        for record in name_table.names:
            if record.nameID == 1 and (record.platformID, record.platEncID, record.langID) in [
                (3, 1, 0x409),
                (1, 0, 0),
            ]:
                family_name = record.toUnicode()
                break

    # 3) If still not found, just take the first nameID=1
    if not family_name:
        for record in name_table.names:
            if record.nameID == 1:
                family_name = record.toUnicode()
                break

    if not family_name:
        family_name = "Unknown"

    # ----- Subfamily name (try nameID=17 first, else fallback to nameID=2) -----
    subfamily_name = None

    # 1) Attempt to find nameID=17 (typographic subfamily)
    for record in name_table.names:
        if record.nameID == 17 and (record.platformID, record.platEncID, record.langID) in [
            (3, 1, 0x409),
            (1, 0, 0),
        ]:
            subfamily_name = record.toUnicode()
            break

    # 2) If not found, fallback to nameID=2 (subfamily name)
    if not subfamily_name:
        for record in name_table.names:
            if record.nameID == 2 and (record.platformID, record.platEncID, record.langID) in [
                (3, 1, 0x409),
                (1, 0, 0),
            ]:
                subfamily_name = record.toUnicode()
                break

    if not subfamily_name:
        subfamily_name = "Unknown"

    # ----- Numeric weight and italic from OS/2 table -----
    os2_table = font["OS/2"]
    numeric_weight = os2_table.usWeightClass
    is_italic = bool(os2_table.fsSelection & 0x01)

    # ----- Create a "weight_title" -----
    # Two approaches:
    #   (a) Use the numeric weight -> a known name (e.g. 400 => "Regular")
    #   (b) Parse the subfamily name.
    # Often subfamily contains words like "Bold", "Light", "Italic", etc.
    # For demonstration, we’ll start with the numeric approach, then refine
    # with subfamily if it has extra hints like "Book".

    weight_title = get_weight_title_from_usWeightClass(numeric_weight)

    # If the subfamily name is something more specific like "Book", "Hair",
    # etc., we might prefer that over the standard numeric name.
    # Let's do a naive check:
    #   If subfamily_name is not "Regular" / "Unknown" / "Italic"
    #   (or any typical fallback), override.
    #   If subfamily_name includes "Italic", we keep that separate in 'is_italic'
    #   so we’ll remove "Italic" from the subfamily when checking weight info.

    subfam_lower = subfamily_name.lower()
    if "italic" in subfam_lower:
        # remove "italic" for weight comparison
        possible_weight_title = subfam_lower.replace("italic", "").strip()
    else:
        possible_weight_title = subfam_lower

    # If that leftover is something that’s not just "regular" or blank,
    # let’s use it
    if (
        possible_weight_title
        and possible_weight_title not in ["regular", "unknown"]
    ):
        # Capitalize properly
        weight_title = possible_weight_title.title()

    return {
        "file": os.path.basename(ttf_path),
        "name": family_name,
        "weight": numeric_weight, # e.g. 400, 500, 600
        "weight_title": weight_title,     # e.g. "Book", "Light", "SemiBold", ...
        "italic": is_italic,
    }

def parse_font_info_in_memory(font_data: bytes, filename: str) -> FontMetadata:
    """
    Parse a TTF font entirely in memory (e.g. from DB asset) and produce metadata.
    """
    try:
        font = TTFont(io.BytesIO(font_data))
    except Exception:
        raise ValueError("Unable to parse font data from memory")

    name_table = font["name"]
    family_name = None

    # Attempt nameID=16 (typographic family name), else fallback to nameID=1
    for record in name_table.names:
        if record.nameID == 16 and (record.platformID, record.platEncID, record.langID) in [(3, 1, 0x409), (1, 0, 0)]:
            family_name = record.toUnicode()
            break
    if not family_name:
        for record in name_table.names:
            if record.nameID == 1 and (record.platformID, record.platEncID, record.langID) in [(3, 1, 0x409), (1, 0, 0)]:
                family_name = record.toUnicode()
                break
    if not family_name:
        family_name = "Unknown"

    # subfamily name (check ID=17, else fallback to ID=2)
    subfamily_name = None
    for record in name_table.names:
        if record.nameID == 17 and (record.platformID, record.platEncID, record.langID) in [(3, 1, 0x409), (1, 0, 0)]:
            subfamily_name = record.toUnicode()
            break
    if not subfamily_name:
        for record in name_table.names:
            if record.nameID == 2 and (record.platformID, record.platEncID, record.langID) in [(3, 1, 0x409), (1, 0, 0)]:
                subfamily_name = record.toUnicode()
                break
    if not subfamily_name:
        subfamily_name = "Unknown"

    os2_table = font["OS/2"]
    numeric_weight = os2_table.usWeightClass
    is_italic = bool(os2_table.fsSelection & 0x01)
    weight_title = get_weight_title_from_usWeightClass(numeric_weight)

    # If subfamily has more specific info (besides 'Regular'/'Unknown'/'Italic'), override
    subfam_lower = subfamily_name.lower()
    if "italic" in subfam_lower:
        possible_weight_title = subfam_lower.replace("italic", "").strip()
    else:
        possible_weight_title = subfam_lower
    if possible_weight_title not in ["regular", "unknown", ""]:
        weight_title = possible_weight_title.title()

    return FontMetadata(
        file=filename,
        name=family_name,
        weight=numeric_weight,
        weight_title=weight_title,
        italic=is_italic
    )


def gather_all_fonts_info(folder_path):
    """
    Scans the folder for .ttf files and gathers
    the name (family_name), weight,
    weight_title, and italic/normal info.
    """
    all_info = []
    for file_name in os.listdir(folder_path):
        if file_name.lower().endswith(".ttf"):
            ttf_path = os.path.join(folder_path, file_name)
            font_info = get_font_info(ttf_path)
            all_info.append(font_info)
    return all_info
