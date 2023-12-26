FROM python:3.9-slim-bullseye

WORKDIR /srv/frameos

RUN apt-get update && apt-get install -y curl build-essential libffi-dev sudo

COPY requirements.txt .
RUN pip3 install --upgrade pip \
    && pip3 install --no-cache-dir -r requirements.txt

COPY . .

RUN apt-get remove -y build-essential libffi-dev \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* 

EXPOSE 8787

CMD ["sh", "-c", "python3 run.py"]
