FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
# Keep the database outside the container: mount a volume at /app/data
CMD ["npm", "start"]
