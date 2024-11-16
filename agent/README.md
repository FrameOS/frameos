# FrameOS Agent

The FrameOS agent:
- Runs alongside FrameOS on the frame
- Acts as a reverse SSH connection into the frame
- Monitors 

The frame initialization procedure when deploying to a frame via ssh:
- Deploy FrameOS and agent over ssh onto the frame
- Create a new keypair on the frame, store the public key on the host, the private key on the frame.
- Let the user print out a qr code/sticker with the frame's pairing key (part of private key? some token?) and host url and place it on the frame for future re-pairing.

Installation on a new pi that wants to connect to a host:
- SSH into a raspberry pi
- curl ... to install FrameOS Agent, provide it with a hostname (borg.frameos.net by default)
- it connects to the host and announces it as a new frame, sends the new public key.

Someone duplicates the sd card 
- update keys every time a connection is made? 
- update a counter per public key?
- or just allow and plan for it? s

The holy grail ux:
- Download the FrameOS flasher
- Set your frame type, wifi credentials, pi board, hostname + account_id, and hit burn
- Once the pi powers up it'll connect to the host and announce itself for adoption
- Log in to your account and click "adopt"
- Keys will be generated and exchanged.

In the interface, show as frame status: "connected, 2 clients".

All demo frames (of the same type) that are up for sale would be running the same default scene, and all would connect to the host if possible. They all can then be adopted.

To swap accounts, enter a pairing code. s


