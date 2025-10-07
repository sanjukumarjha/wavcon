# Step 1: Start with an official Node.js base image.
# This image includes Node.js, npm, and a Linux operating system.
FROM node:20-slim

# Step 2: Install Python and other necessary tools.
# This is the crucial step that fixes the deployment error.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Step 3: Set up the working directory inside the container.
WORKDIR /app

# Step 4: Copy over the package.json and package-lock.json files first.
# This optimizes Docker's caching, so it only reinstalls dependencies when they change.
COPY package*.json ./

# Step 5: Install all Node.js dependencies.
# This will now succeed because Python is installed in the container.
RUN npm install

# Step 6: Copy the rest of your server code into the container.
COPY . .

# Step 7: Expose the port your application will run on.
# Railway will automatically use the PORT variable, but this is good practice.
EXPOSE 3001

# Step 8: Define the command to start the server when the container runs.
CMD [ "npm", "start" ]