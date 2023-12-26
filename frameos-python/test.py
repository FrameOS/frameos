import unittest

def run():
    """Run all tests in the 'tests' directory."""
    loader = unittest.TestLoader()
    suite = loader.discover('frame/test')
    runner = unittest.TextTestRunner(verbosity=2)
    runner.run(suite)

if __name__ == '__main__':
    run()
