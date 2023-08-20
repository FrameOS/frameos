import traceback
import atexit

from frame.server import Server
from frame.config import Config
from frame.logger import Logger

if __name__ == '__main__':
    config = Config()
    logger = Logger(config=config, limit=100)
    atexit.register(logger.stop)
    try:
        server = Server(config=config, logger=logger)
        server.run()
    except Exception as e:
        logger.log({ 'event': '@frame:error', 'error': traceback.format_exc() })
        print(traceback.format_exc())
