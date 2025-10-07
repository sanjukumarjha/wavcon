# Use official Node.js slim image
FROM node:20-slim

# Install Python and other system dependencies required for yt-dlp
RUN apt-get update && apt-get install -y \
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

# NOTE: The EXPOSE line has been removed. 
# Railway will automatically detect the port from the PORT environment variable your app uses.

# Start the app
CMD ["node", "index.js"]
