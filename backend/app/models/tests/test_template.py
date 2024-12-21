import pytest
from app.models.template import Template

@pytest.mark.asyncio
async def test_create_template(db_session):
    t = Template(name="MyTemplate", description="A template", scenes=[{"scene": 1}], config=None)
    db_session.add(t)
    db_session.commit()
    assert t.id is not None
    assert t.name == "MyTemplate"
    assert t.scenes == [{"scene": 1}]

@pytest.mark.asyncio
async def test_template_to_dict(db_session):
    t = Template(
        name="TemplateWithImage",
        description="desc",
        scenes=[],
        config={},
        image=b"rawbinarydata",
        image_width=640,
        image_height=480
    )
    db_session.add(t)
    db_session.commit()
    t_dict = t.to_dict()
    assert t_dict["name"] == "TemplateWithImage"
    assert t_dict["image"].startswith("/api/templates/")  # because that’s how your to_dict() is defined
    assert t_dict["imageWidth"] == 640
    assert t_dict["imageHeight"] == 480
