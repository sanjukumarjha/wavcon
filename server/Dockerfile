# Step 1: Start with an official Node.js base image.
FROM node:20-slim

# Step 2: Install Python and other necessary tools.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# --- THIS IS THE FIX ---
# Step 3: Create a symbolic link so that the command "python" points to "python3".
# This makes Python accessible to scripts that are hardcoded to look for "python".
RUN ln -s /usr/bin/python3 /usr/bin/python

# Step 4: Set up the working directory inside the container.
WORKDIR /app

# Step 5: Copy over the package.json and package-lock.json files first.
COPY package*.json ./

# Step 6: Install all Node.js dependencies.
# This will now succeed because "python" is now a valid command.
RUN npm install

# Step 7: Copy the rest of your server code into the container.
COPY . .

# Step 8: Expose the port your application will run on.
EXPOSE 3001

# Step 9: Define the command to start the server when the container runs.
CMD [ "npm", "start" ]