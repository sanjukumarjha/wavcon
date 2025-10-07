# Step 1: Start with an official Node.js base image.
# This provides Node.js, npm, and a Linux OS.
FROM node:20-slim

# Step 2: Install Python, which is a dependency for yt-dlp.
# This is the crucial step that fixes the "python binary not found" error.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Step 3: Create a symbolic link so the command "python" points to "python3".
# This makes Python accessible to scripts that are hardcoded to look for "python".
RUN ln -s /usr/bin/python3 /usr/bin/python

# Step 4: Set up the working directory inside the container.
WORKDIR /app

# Step 5: Copy over the package.json and package-lock.json files first.
# This optimizes Docker's caching.
COPY package*.json ./

# Step 6: Install all Node.js dependencies.
# This will now succeed because Python is installed and the preinstall script is gone.
RUN npm install

# Step 7: Copy the rest of your server code into the container.
COPY . .

# Step 8: Expose the port your application will run on.
EXPOSE 3001

# Step 9: Define the command to start the server.
CMD [ "npm", "start" ]