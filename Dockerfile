# Use the official Python 3.9 image as the base
FROM python:3.9-slim-bullseye

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

# Copy the requirements file and install using pip
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip3 install --upgrade pip \
    && pip3 install --no-cache-dir -r requirements.txt

# Change the working directory for npm install
WORKDIR /tmp/frontend

# Copy the npm configuration files
COPY frontend/package.json frontend/package-lock.json /tmp/frontend/

# Install npm packages
RUN npm install

# Copy frontend source files and run build
COPY frontend/ ./
RUN npm run build

# Delete all files except the dist folder
RUN find . -maxdepth 1 ! -name 'dist' ! -name '.' ! -name '..' -exec rm -rf {} \;

# Cleanup node installations and build tools
RUN apt-get remove -y nodejs curl build-essential libffi-dev ca-certificates gnupg \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /app/frontend/node_modules \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Change back to the main directory
WORKDIR /app

# Copy the rest of the application to the container
COPY . .

RUN rm -rf /app/frontend && mv /tmp/frontend /app/

EXPOSE 8999

# Start huey in the background and then run the Flask application
CMD ["sh", "-c", "redis-server --daemonize yes && cd backend && flask db upgrade && huey_consumer.py app.huey --worker-type=greenlet --workers=10 --flush-locks & cd backend && python3 run.py"]
