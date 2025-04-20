import uuid
from sqlalchemy import Integer, String, LargeBinary, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import relationship, backref, mapped_column
from app.database import Base

class SceneImage(Base):
    """
    Stores the *latest* rendered image for every (frame_id, scene_id) pair.
    The row is *up‑serted* whenever a fresher snapshot is available.
    """
    __tablename__   = "scene_image"
    __table_args__  = (UniqueConstraint("frame_id", "scene_id", name="u_frame_scene"),)

    id        = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    frame_id  = mapped_column(Integer, ForeignKey("frame.id"), nullable=False)
    scene_id  = mapped_column(String(128),               nullable=False)

    image     = mapped_column(LargeBinary, nullable=False)
    width     = mapped_column(Integer)
    height    = mapped_column(Integer)

    # handy backref – Frame.scene_images
    frame     = relationship("Frame", backref=backref("scene_images", lazy=True))

    def to_dict(self):
        return {
            "id":        self.id,
            "timestamp": self.timestamp.isoformat(),
            "frame_id":  self.frame_id,
            "scene_id":  self.scene_id,
            "width":     self.width,
            "height":    self.height,
        }
