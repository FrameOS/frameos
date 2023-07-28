Steps to convert this to something real.

[ ] Change the frontend to React or something else
[ ] Loading spinners for all buttons
[ ] Add SSH credentials via a form.
[ ] Deployment output live streaming
[ ] Merge frame.py and new.py


Overall flow:

1. Install the FrameOS dashboard. Either standalone or via Home Assistant
2. Set up a raspbian on a sd card, and plug it into your frame
3. Make sure you can reach it via SSH
4. Add its IP in the dashboard, and initialize it.
5. The software is installed. You see a live feed when it's happening (like esphome)
6. You can specify what the frame shows. 
7. The HA integration can also take screenshots of HA
