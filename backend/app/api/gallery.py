import io
import re
import uuid
from pathlib import Path
from typing import Iterable, Optional

from fastapi import Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.gallery import Gallery, GalleryImage, remove_gallery_directory, remove_image_files
from app.models.settings import get_settings_dict
from app.schemas.gallery import (
    GalleryCreateRequest,
    GalleryImageResponse,
    GalleryImagesListResponse,
    GalleryListResponse,
    GalleryResponse,
    GalleryUpdateRequest,
)
from . import api_with_auth


DEFAULT_STORAGE_SETTING = "./db/gallery/"
THUMBNAIL_SIZE = 512


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _resolve_storage_location(raw_value: Optional[str]) -> Path:
    value = raw_value or DEFAULT_STORAGE_SETTING
    value = value.strip()
    if not value:
        value = "./db/gallery/"
    path = Path(value)
    if not path.is_absolute():
        path = (_repo_root() / path).resolve()
    return path


def _storage_base_path(db: Session) -> Path:
    settings = get_settings_dict(db)
    gallery_settings = settings.get("gallery") or {}
    location = gallery_settings.get("imageStorageLocation")
    base_path = _resolve_storage_location(location)
    base_path.mkdir(parents=True, exist_ok=True)
    return base_path


def _serialize_gallery(gallery: Gallery, image_count: int) -> dict:
    return GalleryResponse(
        id=gallery.id,
        name=gallery.name,
        description=gallery.description,
        image_count=image_count,
        created_at=gallery.created_at,
        updated_at=gallery.updated_at,
    ).model_dump()


def _content_type_from_extension(extension: Optional[str]) -> str:
    ext = (extension or "").lower().lstrip(".")
    if ext in {"jpg", "jpeg"}:
        return "image/jpeg"
    if ext == "png":
        return "image/png"
    if ext == "gif":
        return "image/gif"
    if ext == "webp":
        return "image/webp"
    if ext == "bmp":
        return "image/bmp"
    return f"image/{ext or 'jpeg'}"


def _sanitize_filename(filename: Optional[str]) -> str:
    if not filename:
        return "image"
    name = Path(filename).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name or "image"


def _image_extension(upload: UploadFile, pil_image: Image.Image) -> str:
    filename_ext = Path(upload.filename or "").suffix.lower()
    if filename_ext:
        return filename_ext
    if pil_image.format:
        return f".{pil_image.format.lower()}"
    return ".jpg"


def _ensure_thumbnail(
    gallery_image: GalleryImage,
    base_path: Path,
    original_path: Path,
) -> Path:
    gallery_path = base_path / str(gallery_image.gallery_id)
    if gallery_image.thumbnail_path:
        thumb_path = gallery_path / gallery_image.thumbnail_path
        if thumb_path.exists():
            return thumb_path
    else:
        thumb_path = gallery_path / "thumbs" / f"{gallery_image.id}{gallery_image.extension or '.jpg'}"

    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(original_path) as source:
        thumbnail = source.copy()
        resample = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
        thumbnail.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE), resample)
        if thumb_path.suffix.lower() in {".jpg", ".jpeg"} and thumbnail.mode in {"RGBA", "LA"}:
            thumbnail = thumbnail.convert("RGB")
        save_kwargs = {"quality": 90, "optimize": True} if thumb_path.suffix.lower() in {".jpg", ".jpeg"} else {}
        thumbnail.save(thumb_path, **save_kwargs)

    if not gallery_image.thumbnail_path:
        gallery_image.thumbnail_path = str(thumb_path.relative_to(gallery_path))
    return thumb_path


def _serialize_image(image: GalleryImage) -> GalleryImageResponse:
    thumbnail_url = None
    if image.thumbnail_path:
        thumbnail_url = f"/api/galleries/{image.gallery_id}/images/{image.id}/thumbnail"
    return GalleryImageResponse(
        id=image.id,
        gallery_id=image.gallery_id,
        filename=image.filename,
        mime_type=image.mime_type,
        extension=image.extension,
        width=image.width,
        height=image.height,
        file_size=image.file_size,
        created_at=image.created_at,
        updated_at=image.updated_at,
        thumbnail_url=thumbnail_url,
        original_url=f"/api/galleries/{image.gallery_id}/images/{image.id}/render",
    )


def _variant_path(gallery_path: Path, image: GalleryImage, width: Optional[int], height: Optional[int]) -> Path:
    size_key = f"{width or 0}x{height or 0}"
    extension = image.extension or Path(image.original_path).suffix or ".jpg"
    cache_dir = gallery_path / "cache" / size_key
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{image.id}{extension}"


def _generate_variant(source_path: Path, target_path: Path, width: Optional[int], height: Optional[int]):
    with Image.open(source_path) as source:
        resample = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
        if width and height:
            img = source.copy()
            img.thumbnail((width, height), resample)
        elif width:
            ratio = width / source.width
            img = source.resize((width, max(1, int(source.height * ratio))), resample)
        elif height:
            ratio = height / source.height
            img = source.resize((max(1, int(source.width * ratio)), height), resample)
        else:
            img = source.copy()

        if target_path.suffix.lower() in {".jpg", ".jpeg"} and img.mode in {"RGBA", "LA"}:
            img = img.convert("RGB")

        save_kwargs = {"quality": 90, "optimize": True} if target_path.suffix.lower() in {".jpg", ".jpeg"} else {}
        target_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(target_path, **save_kwargs)


def _load_gallery(db: Session, gallery_id: int) -> Gallery:
    gallery = db.get(Gallery, gallery_id)
    if not gallery:
        raise HTTPException(status_code=404, detail="Gallery not found")
    return gallery


def _load_gallery_image(db: Session, gallery_id: int, image_id: str) -> GalleryImage:
    image = db.query(GalleryImage).filter(GalleryImage.gallery_id == gallery_id, GalleryImage.id == image_id).first()
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    return image


@api_with_auth.get("/galleries", response_model=GalleryListResponse)
async def list_galleries(db: Session = Depends(get_db)):
    results: Iterable[tuple[Gallery, int]] = (
        db.query(Gallery, func.count(GalleryImage.id))
        .outerjoin(GalleryImage)
        .group_by(Gallery.id)
        .order_by(Gallery.created_at.desc())
        .all()
    )
    return {
        "galleries": [_serialize_gallery(gallery, count) for gallery, count in results],
    }


@api_with_auth.post("/galleries", response_model=GalleryResponse, status_code=201)
async def create_gallery(request: GalleryCreateRequest, db: Session = Depends(get_db)):
    gallery = Gallery(name=request.name, description=request.description)
    db.add(gallery)
    db.commit()
    db.refresh(gallery)

    base_path = _storage_base_path(db)
    (base_path / str(gallery.id)).mkdir(parents=True, exist_ok=True)
    (base_path / str(gallery.id) / "original").mkdir(parents=True, exist_ok=True)
    (base_path / str(gallery.id) / "thumbs").mkdir(parents=True, exist_ok=True)
    (base_path / str(gallery.id) / "cache").mkdir(parents=True, exist_ok=True)

    return _serialize_gallery(gallery, 0)


@api_with_auth.get("/galleries/{gallery_id}", response_model=GalleryResponse)
async def get_gallery(gallery_id: int, db: Session = Depends(get_db)):
    gallery = _load_gallery(db, gallery_id)
    image_count = db.query(func.count(GalleryImage.id)).filter(GalleryImage.gallery_id == gallery_id).scalar() or 0
    return _serialize_gallery(gallery, image_count)


@api_with_auth.patch("/galleries/{gallery_id}", response_model=GalleryResponse)
async def update_gallery(gallery_id: int, request: GalleryUpdateRequest, db: Session = Depends(get_db)):
    gallery = _load_gallery(db, gallery_id)
    if request.name is not None:
        gallery.name = request.name
    if request.description is not None:
        gallery.description = request.description
    db.add(gallery)
    db.commit()
    db.refresh(gallery)
    image_count = db.query(func.count(GalleryImage.id)).filter(GalleryImage.gallery_id == gallery_id).scalar() or 0
    return _serialize_gallery(gallery, image_count)


@api_with_auth.delete("/galleries/{gallery_id}", status_code=204)
async def delete_gallery(gallery_id: int, db: Session = Depends(get_db)):
    gallery = _load_gallery(db, gallery_id)
    base_path = _storage_base_path(db)
    db.delete(gallery)
    db.commit()
    remove_gallery_directory(base_path, gallery_id)
    return None


@api_with_auth.get("/galleries/{gallery_id}/images", response_model=GalleryImagesListResponse)
async def list_gallery_images(gallery_id: int, db: Session = Depends(get_db)):
    _load_gallery(db, gallery_id)
    images = (
        db.query(GalleryImage)
        .filter(GalleryImage.gallery_id == gallery_id)
        .order_by(GalleryImage.created_at.desc())
        .all()
    )
    return {"images": [_serialize_image(image) for image in images]}


@api_with_auth.post("/galleries/{gallery_id}/images", response_model=GalleryImagesListResponse)
async def upload_gallery_images(
    gallery_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    gallery = _load_gallery(db, gallery_id)
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    base_path = _storage_base_path(db)
    gallery_path = base_path / str(gallery.id)
    gallery_path.mkdir(parents=True, exist_ok=True)
    (gallery_path / "original").mkdir(parents=True, exist_ok=True)
    (gallery_path / "thumbs").mkdir(parents=True, exist_ok=True)
    (gallery_path / "cache").mkdir(parents=True, exist_ok=True)

    for upload in files:
        contents = await upload.read()
        if not contents:
            continue
        try:
            with Image.open(io.BytesIO(contents)) as pil_image:
                width, height = pil_image.size
                extension = _image_extension(upload, pil_image)
                mime_type = upload.content_type or Image.MIME.get(pil_image.format, _content_type_from_extension(extension))

                safe_filename = _sanitize_filename(upload.filename)
                image_id = str(uuid.uuid4())
                original_filename = f"{image_id}{extension}"
                original_relative = Path("original") / original_filename
                original_path = gallery_path / original_relative
                original_path.write_bytes(contents)

                image_record = GalleryImage(
                    id=image_id,
                    gallery_id=gallery.id,
                    filename=safe_filename,
                    original_path=str(original_relative),
                    thumbnail_path=None,
                    mime_type=mime_type,
                    extension=extension,
                    width=width,
                    height=height,
                    file_size=len(contents),
                )

                thumb_path = _ensure_thumbnail(image_record, base_path, original_path)
                image_record.thumbnail_path = str(thumb_path.relative_to(gallery_path))

                db.add(image_record)
        except UnidentifiedImageError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"Invalid image uploaded: {upload.filename}") from exc

    db.commit()

    images = (
        db.query(GalleryImage)
        .filter(GalleryImage.gallery_id == gallery_id)
        .order_by(GalleryImage.created_at.desc())
        .all()
    )
    return {"images": [_serialize_image(image) for image in images]}


@api_with_auth.delete("/galleries/{gallery_id}/images/{image_id}", response_model=GalleryImagesListResponse)
async def delete_gallery_image(gallery_id: int, image_id: str, db: Session = Depends(get_db)):
    image = _load_gallery_image(db, gallery_id, image_id)
    base_path = _storage_base_path(db)
    remove_image_files(base_path, image)
    db.delete(image)
    db.commit()

    images = (
        db.query(GalleryImage)
        .filter(GalleryImage.gallery_id == gallery_id)
        .order_by(GalleryImage.created_at.desc())
        .all()
    )
    return {"images": [_serialize_image(item) for item in images]}


@api_with_auth.get("/galleries/{gallery_id}/images/{image_id}/thumbnail")
async def get_gallery_thumbnail(gallery_id: int, image_id: str, db: Session = Depends(get_db)):
    image = _load_gallery_image(db, gallery_id, image_id)
    base_path = _storage_base_path(db)
    gallery_path = base_path / str(gallery_id)
    original_path = gallery_path / image.original_path
    if not original_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    thumb_path = _ensure_thumbnail(image, base_path, original_path)
    db.add(image)
    db.commit()

    return FileResponse(
        thumb_path,
        media_type=image.mime_type or _content_type_from_extension(image.extension),
        headers={"Cache-Control": "public, max-age=3600"},
    )


@api_with_auth.get("/galleries/{gallery_id}/images/{image_id}/render")
async def render_gallery_image(
    gallery_id: int,
    image_id: str,
    width: Optional[int] = Query(None, gt=0),
    height: Optional[int] = Query(None, gt=0),
    db: Session = Depends(get_db),
):
    image = _load_gallery_image(db, gallery_id, image_id)
    base_path = _storage_base_path(db)
    gallery_path = base_path / str(gallery_id)
    original_path = gallery_path / image.original_path
    if not original_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    if width is None and height is None:
        return FileResponse(
            original_path,
            media_type=image.mime_type or _content_type_from_extension(image.extension),
            headers={"Cache-Control": "public, max-age=3600"},
        )

    variant_path = _variant_path(gallery_path, image, width, height)
    if not variant_path.exists():
        _generate_variant(original_path, variant_path, width, height)

    return FileResponse(
        variant_path,
        media_type=image.mime_type or _content_type_from_extension(image.extension),
        headers={"Cache-Control": "public, max-age=3600"},
    )
