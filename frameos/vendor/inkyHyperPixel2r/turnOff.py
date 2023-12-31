if __name__ == "__main__":
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    pin = 19
    GPIO.setup(pin, GPIO.OUT)
    pwm = GPIO.PWM(pin, 1000)
    pwm.start(0)
    pwm.stop()
