from sqlalchemy.orm import Session
from app.models.frame import Frame
from app.schemas.frame import FrameCreate, FrameUpdate
from app.utils.token import secure_token

def create_frame(db: Session, data: FrameCreate) -> Frame:
    user = 'pi'
    password = None
    ssh_port = 22
    frame_host = data.frame_host

    # Parse frame_host user/password/port like original code did
    # Simplified example:
    if '@' in frame_host:
        user_pass, frame_host = frame_host.split('@')
        if ':' in user_pass:
            user, password = user_pass.split(':')
        else:
            user = user_pass

    if ':' in frame_host:
        host_only, ssh_port_str = frame_host.split(':')
        frame_host = host_only
        ssh_port = int(ssh_port_str or '22')
        if ssh_port < 0 or ssh_port > 65535:
            raise ValueError("Invalid SSH port")

    # Parse server_host similarly
    server_host = data.server_host
    server_port = 8989
    if ':' in server_host:
        server_host, server_port_str = server_host.split(':')
        server_port = int(server_port_str)

    frame = Frame(
        name=data.name,
        ssh_user=user,
        ssh_pass=password,
        ssh_port=ssh_port,
        frame_host=frame_host,
        frame_access_key=secure_token(20),
        frame_access="private",
        server_host=server_host,
        server_port=server_port,
        server_api_key=secure_token(32),
        interval=data.interval or 60,
        status="uninitialized",
        apps=[],
        scenes=[],
        scaling_mode="contain",
        rotate=0,
        device=data.device or "web_only",
        log_to_file=None,
        assets_path='/srv/assets',
        save_assets=True,
        control_code={"enabled": "true", "position": "top-right"},
        reboot={"enabled": "true", "crontab": "4 0 * * *"},
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    # Emit socket event, create log, etc. as needed
    return frame

def get_frame(db: Session, frame_id: int) -> Frame:
    return db.query(Frame).filter(Frame.id == frame_id).first()

def get_frames(db: Session):
    return db.query(Frame).all()

def update_frame(db: Session, frame: Frame, data: FrameUpdate) -> Frame:
    # Set only fields that are present in data
    update_data = data.dict(exclude_unset=True)
    for field, value in update_data.items():
        if field == "next_action":
            continue
        setattr(frame, field, value)
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame

def delete_frame(db: Session, frame_id: int) -> bool:
    frame = get_frame(db, frame_id)
    if frame:
        db.delete(frame)
        db.commit()
        return True
    return False
