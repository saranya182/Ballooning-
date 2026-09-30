FROM node:20-alpine

WORKDIR /app

# Copy root config
COPY package.json ./

# Copy backend and frontend package files
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install backend dependencies
RUN cd backend && npm install

# Install frontend dependencies
RUN cd frontend && npm install

# Copy the rest of the application code
COPY . .

# Build the frontend for production
# VITE_API_URL is set so the frontend knows to call the same domain
RUN cd frontend && echo "VITE_API_URL=/api" > .env.production && npm run build

# Change to backend directory for runtime
WORKDIR /app/backend

# Expose the API and Web port
EXPOSE 5000

# Start the application
CMD ["npm", "start"]
