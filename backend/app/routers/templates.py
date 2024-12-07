import io
import zipfile
import base64
import requests
import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, File, UploadFile, Body, Response
from sqlalchemy.orm import Session
from PIL import Image

from app.core.deps import get_db, get_current_user
from app.crud.template import get_template, get_all_templates, create_template_record, update_template_record, delete_template_record
from app.models.template import Template
from app.schemas.template import TemplateUpdate
from app.utils.respond_with_template import respond_with_template
from app.models.frame import Frame
from app import redis

router = APIRouter(tags=["templates"])

@router.post("/templates")
def create_template(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Body(None),
    name: Optional[str] = Body(None),
    description: Optional[str] = Body(None),
    scenes: Optional[list] = Body(None),
    config: Optional[dict] = Body(None),
    from_frame_id: Optional[str] = Body(None),
    format: Optional[str] = Body(None),
):
    # This logic mimics the old code. Priority:
    # 1. If file is uploaded, use that zip
    # 2. Else if url provided, fetch zip from URL
    # 3. Else use json data as provided

    data = {
        "name": name,
        "description": description,
        "scenes": scenes,
        "config": config,
        "from_frame_id": from_frame_id
    }

    zip_file_content = None
    if file is not None:
        zip_file_content = file.file.read()
    elif url:
        zip_file_content = requests.get(url).content

    if zip_file_content:
        zip_file = zipfile.ZipFile(io.BytesIO(zip_file_content))
        folder_name = ''
        for n in zip_file.namelist():
            if n == 'template.json':
                folder_name = ''
                break
            elif n.endswith('/template.json'):
                # find the shortest path to template.json if multiple
                if folder_name == '' or len(n) < len(folder_name):
                    folder_name = n[:-len('template.json')]

        template_json = zip_file.read(f'{folder_name}template.json')
        scenes_json = zip_file.read(f'{folder_name}scenes.json')
        data = json.loads(template_json)
        data['scenes'] = json.loads(scenes_json)

        image_ref = data.get('image', '')
        image_data = None
        if isinstance(image_ref, str):
            if image_ref.startswith('data:image/'):
                # base64 inline image
                image_data = base64.b64decode(image_ref.split(';base64,')[1])
            elif image_ref.startswith('./'):
                image_name = image_ref[len('./'):]
                image_data = zip_file.read(f'{folder_name}{image_name}')
            elif image_ref.startswith('http:') or image_ref.startswith('https:'):
                image_data = requests.get(image_ref).content

        data['image'] = image_data
        if image_data:
            img = Image.open(io.BytesIO(image_data))
            data['imageWidth'] = img.width
            data['imageHeight'] = img.height

    if data.get('from_frame_id'):
        frame_id = data.get('from_frame_id')
        frame = db.query(Frame).get(frame_id)
        if frame:
            cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
            last_image = redis.get(cache_key)
            if last_image:
                try:
                    img = Image.open(io.BytesIO(last_image))
                    data['image'] = last_image
                    data['imageWidth'] = img.width
                    data['imageHeight'] = img.height
                except:
                    pass

    # Create new template in DB unless format=zip or scenes requested
    if format == 'zip' or format == 'scenes':
        # Create a temporary template object to export
        temp_template = Template(
            name=data.get('name'),
            description=data.get('description'),
            scenes=data.get('scenes'),
            config=data.get('config'),
            image=data.get('image'),
            image_width=data.get('imageWidth'),
            image_height=data.get('imageHeight'),
        )
        if format == 'zip':
            return respond_with_template(temp_template)
        elif format == 'scenes':
            return Response(content=json.dumps(temp_template.scenes), status_code=201, media_type='application/json')
    else:
        # Persist in DB
        created = create_template_record(
            db,
            name=data.get('name', "Unnamed Template"),
            description=data.get('description') or "",
            scenes=data.get('scenes') or [],
            config=data.get('config') or {},
            image=data.get('image'),
            image_width=data.get('imageWidth') if 'imageWidth' in data else None,
            image_height=data.get('imageHeight') if 'imageHeight' in data else None,
        )
        return created.to_dict(), 201

@router.get("/templates")
def get_templates(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    templates = get_all_templates(db)
    return [t.to_dict() for t in templates]

@router.get("/templates/{template_id}")
def get_template_endpoint(template_id: str, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    template = get_template(db, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template.to_dict()

@router.get("/templates/{template_id}/image")
def get_template_image(template_id: str, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    template = get_template(db, template_id)
    if not template or not template.image:
        raise HTTPException(status_code=404, detail="Template not found")
    return Response(content=template.image, media_type="image/jpeg")

@router.get("/templates/{template_id}/export")
def export_template(template_id: str, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    template = get_template(db, template_id)
    return respond_with_template(template)

@router.patch("/templates/{template_id}")
def update_template(template_id: str, data: TemplateUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    template = get_template(db, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    updated = update_template_record(db, template, name=data.name, description=data.description)
    return updated.to_dict()

@router.delete("/templates/{template_id}")
def delete_template(template_id: str, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    template = get_template(db, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    delete_template_record(db, template)
    return {"message": "Template deleted successfully"}
