# Step 1: Start with an official Node.js base image.
# This provides Node.js, npm, and a Linux OS.
FROM node:20-slim

# Step 2: Install Python. This is the crucial step.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Step 3: Create a symbolic link so that the command "python" points to "python3".
# This makes Python accessible to scripts that are hardcoded to look for "python".
RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app
COPY server/package*.json ./
RUN npm install
COPY server ./
CMD ["npm", "start"]
