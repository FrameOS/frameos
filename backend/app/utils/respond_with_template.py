import io
import zipfile
import json
import string
from fastapi import Response
from app.models.template import Template

def respond_with_template(template: Template) -> Response:
    if not template:
        return Response(content=json.dumps({"error": "Template not found"}), status_code=404, media_type="application/json")

    template_name = template.name or "Template"
    safe_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    template_name = ''.join(c if c in safe_chars else ' ' for c in template_name).strip()
    template_name = ' '.join(template_name.split()) or 'Template'

    template_dict = template.to_dict()
    template_dict.pop('id', None)
    scenes = template_dict.pop('scenes', [])
    # Add relative paths in json
    template_dict['scenes'] = './scenes.json'
    template_dict['image'] = './image.jpg' if template.image else None

    in_memory = io.BytesIO()
    with zipfile.ZipFile(in_memory, 'a', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{template_name}/scenes.json", json.dumps(scenes, indent=2))
        zf.writestr(f"{template_name}/template.json", json.dumps(template_dict, indent=2))
        if template.image:
            zf.writestr(f"{template_name}/image.jpg", template.image)
    in_memory.seek(0)

    headers = {"Content-Disposition": f"attachment; filename={template_name}.zip"}
    return Response(content=in_memory.getvalue(), media_type="application/zip", headers=headers)
