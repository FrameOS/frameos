FROM python:3.9-slim-bullseye

WORKDIR /srv/frameos

COPY . .

# Install build-essential for native extensions
RUN apt-get update && apt-get install -y build-essential libffi-dev \
    && pip3 install --no-cache-dir -r requirements.txt \
    # Cleanup to reduce image size
    && apt-get remove -y build-essential libffi-dev \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* 

EXPOSE 8999

CMD ["sh", "-c", "python3 frame.py"]
