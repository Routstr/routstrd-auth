   docker build -t routstrd .

   docker volume create routstrd-data

   docker run -d \
     --name routstrd \
     --restart unless-stopped \
     -p 8009:8008 \
     -v routstrd-data:/data \
     routstrd

