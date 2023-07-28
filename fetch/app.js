const axios = require('axios');
const fs = require('fs-extra');
const express = require('express');
const path = require('path');

const downloadDir = path.join(__dirname, 'images');

// download image from url and save it to disk
async function downloadImage(url, imagePath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  await response.data.pipe(fs.createWriteStream(imagePath));
}

// main function to download images
async function downloadImages() {
  const url = 'https://source.unsplash.com/random/800x480/?bird';

  // ensure the download directory exists
  await fs.ensureDir(downloadDir);

  const files = await fs.readdir(downloadDir);
  
  // download images only if there are less than 20 images in the directory
  if (files.length < 20) {
    for (let i = files.length; i < 20; i++) {
      const imagePath = path.join(downloadDir, `image${i + 1}.jpg`);
      await downloadImage(url, imagePath);
      console.log(`Image ${i + 1} downloaded`);
    }
  } else {
    console.log('Images already exist, no need to download');
  }
}

// start the express server
const app = express();

app.get('/', async (req, res) => {
  const files = await fs.readdir(downloadDir);
  const selectedFile = files[Math.floor(Math.random() * files.length)];
  res.sendFile(path.join(downloadDir, selectedFile));
});

downloadImages()
  .then(() => {
    const server = app.listen(3000, () => {
      console.log('Server is listening on port 3000');
    });
  })
  .catch(console.error);

