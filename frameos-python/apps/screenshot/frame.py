from PIL import Image
import platform
import io

from apps import App, ExecutionContext


class ScreenshotApp(App):
    def __post_init__(self):
        self.driver = None
        if not self.architecture_supported():
            self.log("Sadly we can't take screenshots in a 32 bit system, as there's no browser that works anymore. Good bye.")
            return
        self.fetch_selenium()
        self.fetch_browser()

    def architecture_supported(self) -> bool:
        return platform.architecture()[0] != '32bit'

    def fetch_selenium(self):
        self.log("Checking for required pip packages: selenium, webdriver-manager")
        try:
            import selenium
        except ImportError:
            self.log("Installing selenium. This might take a while.")
            self.shell(f"pip3 install selenium==4.14.0")
        try:
            import webdriver_manager
        except ImportError:
            self.log("Installing webdriver-manager. This might take a while.")
            self.shell(f"pip3 install webdriver-manager==4.0.1")

    def fetch_browser(self):
        browser = self.get_config('browser', 'chromium')
        if browser == 'chromium':
            self.log("Checking for chromium. Installing via apt if missing.")
            self.shell("dpkg -l | grep -q \"^ii  chromium-browser\" || "
                       "(sudo apt -y update && sudo apt install -y chromium-browser xvfb chromium-chromedriver)")
        elif browser == 'firefox':
            self.log("Checking for firefox. Installing via apt if missing.")
            self.shell("dpkg -l | grep -q \"^ii  firefox-esr\" || "
                       "(sudo apt -y update && sudo apt install -y firefox-esr)")
        else:
            raise ValueError(f"Browser {browser} not supported")

    def init_driver(self):
        browser = self.get_config('browser', 'chromium')
        if browser == 'chromium':
            scaling_factor = str(float(self.get_config('scaling_factor', 1)))
            self.log(f"Creating chromium web driver with scaling factor {scaling_factor}")
            from selenium.webdriver.chrome.options import Options
            from selenium import webdriver
            from selenium.webdriver.chrome.service import Service as ChromiumService

            options = Options()
            options.headless = True
            options.add_argument(f"--force-device-scale-factor={scaling_factor}")
            options.add_argument("--use-gl=swiftshader")
            options.add_argument("--disable-software-rasterizer")
            options.add_argument("--no-sandbox")
            options.add_argument("--headless")
            options.add_argument("--disable-gpu")
            options.add_argument("--disable-dev-shm-usage")
            self.driver = webdriver.Chrome(service=ChromiumService("/usr/bin/chromedriver"), options=options)
            self.log(f"Success! {self.driver.session_id}")
        elif browser == 'firefox':
            self.log("Creating firefox web driver...")
            from selenium import webdriver
            from selenium.webdriver.firefox.service import Service as FirefoxService
            from webdriver_manager.firefox import GeckoDriverManager
            # TODO: as far as I can tell, this installs a non_ARM binary and fails with
            # "OSError: [Errno 8] Exec format error: '/home/raam/.wdm/drivers/geckodriver/linux64/v0.33.0/geckodriver'"
            self.driver = webdriver.Firefox(service=FirefoxService(GeckoDriverManager().install()))
            self.log(f"Success! {self.driver.session_id}")
        else:
            raise ValueError(f"Browser {browser} not supported")

    def run(self, context: ExecutionContext):
        if not self.architecture_supported():
            return

        url = self.get_config('url', None)
        if not url:
            raise ValueError("URL not provided in app config")

        if self.driver is None:
            self.init_driver()
        if not self.driver:
            raise ValueError("Selenium driver not initialized")

        scaling_factor = float(self.get_config('scaling_factor', 1))
        width, height = int(context.image.width / scaling_factor), int(context.image.height / scaling_factor)
        self.log(f"Fetching {url} at {width}x{height} @{scaling_factor}x")
        self.driver.set_window_size(width, height)

        if self.driver.current_url == url:
            self.log(f"Refreshing url: {url}")
            self.driver.refresh()
        else:
            self.log(f"Setting url: {url}")
            self.driver.get(url)

        wait_selector = self.get_config('wait_selector', '')
        if wait_selector:
            timeout = 60
            self.log(f"Waiting for selector: {wait_selector} (timeout: {timeout}sec)")
            try:
                from selenium.webdriver.support import expected_conditions as EC
                from selenium.webdriver.support.ui import WebDriverWait
                element = WebDriverWait(self.driver, timeout).until(
                    EC.visibility_of_element_located(("css selector", wait_selector))
                )
            except Exception as e:
                self.log(f"Error waiting for selector, exiting: {e}")
                return

        wait_delay = int(self.get_config('wait_delay', '0'))
        if wait_delay > 0:
            self.log(f"Waiting {wait_delay} extra seconds")
            self.driver.implicitly_wait(wait_delay)

        self.log(f"Saving screenshot of current url: {self.driver.current_url}")

        content = self.driver.get_screenshot_as_png()
        try:
            self.log(f"Screenshot taken, size: {len(content)} bytes")
        except TypeError as e:
            self.log(f"Screenshot error! Type: {type(content)}. Error: {e}")

        context.image = Image.open(io.BytesIO(content))
