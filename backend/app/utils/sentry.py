from app.database import SessionLocal
from app.models.settings import get_settings_dict
import sentry_sdk
from sqlalchemy.exc import OperationalError

def initialize_sentry():
    with SessionLocal() as db:
        try:
            settings = get_settings_dict(db)
            dsn = settings.get('sentry', {}).get('controller_dsn', None)
        except OperationalError:
            # Could not get settings dict, db not initialized.
            return
        if dsn:
            sentry_sdk.init(dsn=dsn, traces_sample_rate=1.0, profiles_sample_rate=1.0)
