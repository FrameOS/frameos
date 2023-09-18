#!/bin/bash

docker build -t frameos . && docker run -t -i frameos python3 test.py
