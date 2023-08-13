# Use the official Python 3.9 image as the base
FROM python:3.9-slim-bullseye

# Set the working directory
WORKDIR /app

# Install Node.js 18 and build tools
RUN apt-get update && apt-get install -y curl build-essential \
    && curl -sL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Copy the requirements file and install using pip
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

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
RUN apt-get remove -y nodejs build-essential \
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
CMD ["sh", "-c", "huey_consumer.py backend.huey --worker-type=greenlet --workers=10 --flush-locks & python3 app.py"]