# Use official Node.js slim image
FROM node:20-slim

# Install Tini for better signal handling, plus other system dependencies
RUN apt-get update && apt-get install -y \
    tini \
    python3 \
    python3-pip \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Link python3 to python
RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./

# Install dependencies using clean install for production
RUN npm ci --legacy-peer-deps

# Copy the rest of the app source code
COPY . .

# Use Tini as the entrypoint to properly handle signals and reap zombie processes
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the app using npm's process management for better stability
CMD ["npm", "start"]

