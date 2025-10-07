# Use official Node.js sl
FROM node:20-slim

# In
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./

RUN npm install -g npm@11.6.1

RUN npm ci --legacy-peer-deps

COPY . .


EXPOSE 3000  
CMD ["node", "index.js"]
