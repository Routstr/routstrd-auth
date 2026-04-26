   docker build -t routstrd .

   docker volume create routstrd-data

   docker run -d \
     --name routstrd \
     --restart unless-stopped \
     -p 8009:8080 \
     -v routstrd-data:/data \
     routstrd

