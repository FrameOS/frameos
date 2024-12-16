from flask import Blueprint

api: Blueprint = Blueprint('api', __name__)

from .apps import *
from .frames import *
from .login import *
from .repositories import *
from .signup import *
from .settings import *
from .templates import *
from .misc import *
