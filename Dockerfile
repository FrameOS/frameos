# Use the official Python 3.11 image as the base
FROM python:3.11-slim-bullseye

# Set the working directory
WORKDIR /app

# Install Node.js based on platform
RUN apt-get update && apt-get install -y curl build-essential libffi-dev redis-server ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && NODE_MAJOR=18 \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs

# Install Nim
RUN apt-get update && \
  apt-get install -y curl xz-utils gcc openssl ca-certificates git # &&

RUN mkdir -p /opt/nim && \
    curl -L https://nim-lang.org/download/nim-2.2.0.tar.xz | tar -xJf - -C /opt/nim --strip-components=1 && \
    cd /opt/nim && \
    sh build.sh && \
    bin/nim c koch && \
    ./koch boot -d:release && \
    ./koch tools

ENV PATH="/opt/nim/bin:${PATH}"

RUN nim --version \
    nimble --version

# Copy the requirements file and install using pip
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip3 install --upgrade uv \
    && uv venv \
    && uv pip install --no-cache-dir -r requirements.txt

# Change the working directory for npm install
WORKDIR /tmp/frontend

# Copy the npm configuration files
COPY frontend/package.json frontend/package-lock.json /tmp/frontend/

# Install npm packages
RUN npm install

# Copy frontend source files and run build
COPY frontend/ ./
COPY version.json ../
RUN npm run build

# Delete all files except the dist and schema folders
RUN find . -maxdepth 1 ! -name 'dist' ! -name 'schema' ! -name '.' ! -name '..' -exec rm -rf {} \;

# Cleanup node installations and build tools
RUN apt-get remove -y nodejs curl build-essential libffi-dev ca-certificates gnupg \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /app/frontend/node_modules \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Install frameos nim deps
WORKDIR /app/frameos

COPY frameos/frameos.nimble ./
COPY frameos/nimble.lock ./
COPY frameos/nim.cfg ./

RUN nimble install -d -y && nimble setup

# Install frameos agent nim deps
WORKDIR /app/agent

COPY agent/frameos_agent.nimble ./
COPY agent/nimble.lock ./

# Cache nimble deps for when deploying on frame
RUN nimble install -d -y && nimble setup

# Change back to the main directory
WORKDIR /app

# Copy the rest of the application to the container
COPY . .

RUN rm -rf /app/frontend && mv /tmp/frontend /app/

EXPOSE 8989

CMD ["./docker-entrypoint.sh"]
