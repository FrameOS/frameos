from PIL import Image
import platform
import io

from apps import App, ExecutionContext


class ScreenshotApp(App):
    def __post_init__(self):
        self.log("Checking for required pip packages: selenium, webdriver-manager")
        self.driver = None
        self.fetch_browser()

    def fetch_browser(self):
        if platform.architecture()[0] == '32bit':
            self.log("Sadly can not take screenshots in a 32bit environment. Exiting.")
            return

        try:
            import selenium
        except ImportError:
            self.log("Installing selenium. This might take a while.")
            self.shell(f"pip3 install selenium==4.14.0")

        try:
            import webdriver_manager
        except ImportError:
            self.shell(f"pip3 install webdriver-manager==4.0.1")
            self.log("Installing webdriver-manager. This might take a while")

        browser = self.get_config('browser', 'chromium')

        if browser == 'firefox':
            self.log("Checking for firefox. Installing via apt if missing.")
            self.shell("dpkg -l | grep -q \"^ii  firefox-esr\" || "
                       "(sudo apt -y update && sudo apt install -y firefox-esr)")

        elif browser == 'chromium':
            self.log("Checking for chromium. Installing via apt if missing.")
            self.shell("dpkg -l | grep -q \"^ii  chromium-browser\" || "
                       "(sudo apt -y update && sudo apt install -y chromium-browser xvfb chromium-chromedriver)")
        else:
            raise ValueError(f"Browser {browser} not supported")

    def init_driver(self):
        if platform.architecture()[0] == '32bit':
            self.log("Sadly can not take screenshots in a 32bit environment. Exiting.")
            return

        browser = self.get_config('browser', 'chromium')
        if browser == 'firefox':
            # TODO: fails with:
            # "OSError: [Errno 8] Exec format error: '/home/raam/.wdm/drivers/geckodriver/linux64/v0.33.0/geckodriver'"

            self.log("Checking for firefox. Installing via apt if missing.")
            self.shell("dpkg -l | grep -q \"^ii  firefox-esr\" || (sudo apt -y update && sudo apt install -y firefox-esr)")

            self.log("Trying to create firefox web driver...")
            from selenium import webdriver
            from selenium.webdriver.firefox.service import Service as FirefoxService
            from webdriver_manager.firefox import GeckoDriverManager
            self.driver = webdriver.Firefox(service=FirefoxService(GeckoDriverManager().install()))
            self.log(f"Success! {self.driver}")

        elif browser == 'chromium':
            self.log("Checking for chromium. Installing via apt if missing.")
            self.shell("dpkg -l | grep -q \"^ii  chromium-browser\" || "
                       "(sudo apt -y update && "
                       "sudo apt install -y chromium-browser xvfb chromium-chromedriver)")

            self.log("Trying to create chromium web driver...")
            from selenium.webdriver.chrome.options import Options
            from selenium import webdriver
            from selenium.webdriver.chrome.service import Service as ChromiumService

            options = Options()
            options.headless = True
            scaling_factor = str(float(self.config.get('scaling_factor', 1)))
            options.add_argument(f"--force-device-scale-factor={scaling_factor}")
            options.add_argument("--use-gl=swiftshader")
            options.add_argument("--disable-software-rasterizer")
            options.add_argument("--no-sandbox")
            options.add_argument("--headless")
            options.add_argument("--disable-gpu")
            options.add_argument("--disable-dev-shm-usage")
            self.driver = webdriver.Chrome(service=ChromiumService("/usr/bin/chromedriver"), options=options)
            self.log(f"Success! session_id: {self.driver.session_id}")
        else:
            raise ValueError(f"Browser {browser} not supported")

    def run(self, context: ExecutionContext):
        url = self.get_config('url', None)
        if not url:
            raise ValueError("URL not provided in app config")

        self.init_driver()
        if not self.driver:
            raise ValueError("Selenium driver not initialized")

        self.log(f"Fetching: {url}")
        scaling_factor = str(float(self.config.get('scaling_factor', 1)))
        self.driver.set_window_size(context.image.width / scaling_factor, context.image.height / scaling_factor)
        self.driver.get(url)
        self.log(f"Saving screenshot")
        content = self.driver.get_screenshot_as_png()
        self.driver.quit()

        context.image = Image.open(io.BytesIO(content))

