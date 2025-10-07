# Use official Node.js slim image
FROM node:20-slim

# Install Python and other system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Ensure 'python' command exists
RUN ln -s /usr/bin/python3 /usr/bin/python

# Set working directory
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Update npm to a stable version
RUN npm install -g npm@11.6.1

# Install dependencies using clean install
RUN npm ci --legacy-peer-deps

# Copy the rest of the app
COPY . .

# Expose the port for Railway
EXPOSE 3001

# Start the app
CMD ["node", "index.js"]
