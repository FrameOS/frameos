from fastapi import APIRouter

# When not using HASSIO_RUN_MODE (running directly from Docker):
# - api_public: routes intentionally exposed without authentication
# - api_open: routes without router-level authentication, such as login and token-protected media
# - api_user: routes that require an authenticated user
# - api_project: routes that require an authenticated project context

# When using HASSIO_RUN_MODE (Home Assistant ingress with automatic login):
# - api_public: exported to the local network via port 8989, no authentication required
# - api_open: accessible via Home Assistant ingress without router-level authentication
# - api_user: accessible via Home Assistant ingress after Home Assistant authenticates the user
# - api_project: accessible via Home Assistant ingress with project context

api_public = APIRouter()
api_open = APIRouter()
api_user = APIRouter()
api_project = APIRouter()

from .auth import *  # noqa: E402, F403
from .ai_apps import *  # noqa: E402, F403
from .ai_scenes import *  # noqa: E402, F403
from .apps import *  # noqa: E402, F403
from .assets import *  # noqa: E402, F403
from .cloud_auth import *  # noqa: E402, F403
from .chats import *  # noqa: E402, F403
from .frame_bootstrap import *  # noqa: E402, F403
from .frames import *  # noqa: E402, F403
from .fonts import *  # noqa: E402, F403
from .log import *  # noqa: E402, F403
from .projects import *  # noqa: E402, F403
from .repositories import *  # noqa: E402, F403
from .scene_images import *  # noqa: E402, F403
from .settings import *  # noqa: E402, F403
from .system import *  # noqa: E402, F403
from .ssh import *  # noqa: E402, F403
from .templates import *  # noqa: E402, F403
from .users import *  # noqa: E402, F403
