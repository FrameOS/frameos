from sqlalchemy.orm import Session
from app.models.template import Template
from typing import Optional

def get_template(db: Session, template_id: str) -> Optional[Template]:
    return db.query(Template).filter_by(id=template_id).first()

def get_all_templates(db: Session):
    return db.query(Template).all()

def create_template_record(db: Session, name: str, description: str, scenes: list, config: dict, image: bytes, image_width: int, image_height: int) -> Template:
    template = Template(
        name=name,
        description=description,
        scenes=scenes,
        config=config,
        image=image,
        image_width=image_width,
        image_height=image_height
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template

def update_template_record(db: Session, template: Template, name: Optional[str] = None, description: Optional[str] = None) -> Template:
    if name is not None:
        template.name = name
    if description is not None:
        template.description = description
    db.commit()
    db.refresh(template)
    return template

def delete_template_record(db: Session, template: Template):
    db.delete(template)
    db.commit()
