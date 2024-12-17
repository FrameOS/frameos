from fastapi import APIRouter

api = APIRouter()

from .apps import *
from .frames import *
from .log import *
from .repositories import *
from .settings import *
from .ssh import *
from .templates import *

